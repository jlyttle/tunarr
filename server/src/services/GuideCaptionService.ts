import type { ChannelStreamMode } from '@tunarr/types';
import { inArray } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { chunk, head, uniq } from 'lodash-es';
import type { ProgramStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import { Program } from '../db/schema/Program.ts';
import type { ProgramSubtitles } from '../db/schema/ProgramSubtitles.ts';
import {
  buildCelContext,
  evaluateStreamSelectionProfile,
} from '../ffmpeg/StreamSelectionEvaluator.ts';
import type { TextSubtitleResolver } from '../ffmpeg/StreamSelectionEvaluator.ts';
import { SubtitleStreamPicker } from '../ffmpeg/SubtitleStreamPicker.ts';
import {
  mediaStreamsByKind,
  toAudioStreamDetails,
  toEmbeddedSubtitleStreamDetails,
  toStoredSubtitleStreamDetails,
} from '../stream/ProgramStreamDetailsFetcher.ts';
import { resolveSubtitleDelivery } from '../stream/subtitles/SubtitleDeliveryPolicy.ts';
import type { SubtitleStreamDetails } from '../stream/types.ts';
import { isImageBasedSubtitle } from '../stream/util.ts';
import { KEYS } from '../types/inject.ts';
import { isNonEmptyArray, isNonEmptyString } from '../util/index.ts';
import { throttledAccumulate } from '../util/seq.ts';
import { CelEvaluationService } from './CelEvaluationService.ts';
import { FeatureFlagService } from './FeatureFlagService.ts';
import { StreamSelectionProfileResolver } from './StreamSelectionProfileResolver.ts';

const CaptionedStreamModes: ReadonlySet<ChannelStreamMode> = new Set([
  'hls',
  'hls_direct_v2',
]);

const ProgramBatchSize = 500;

const resolveExtractedText: TextSubtitleResolver = (lineupItem, stream) =>
  SubtitleStreamPicker.getSubtitleDetailsWithExtractedPath(lineupItem, stream);

type StoredProgram = Awaited<
  ReturnType<GuideCaptionService['loadPrograms']>
>[number];

@injectable()
export class GuideCaptionService {
  constructor(
    @inject(KEYS.DrizzleDB) private drizzle: DrizzleDBAccess,
    @inject(StreamSelectionProfileResolver)
    private profileResolver: StreamSelectionProfileResolver,
    @inject(CelEvaluationService) private celService: CelEvaluationService,
    @inject(FeatureFlagService) private featureFlags: FeatureFlagService,
  ) {}

  async captionedProgramIds(
    channel: ChannelOrm,
    programIds: string[],
  ): Promise<Set<string>> {
    const captioned = new Set<string>();
    if (!this.channelDeliversHlsCaptions(channel)) {
      return captioned;
    }

    for (const program of await this.loadPrograms(programIds)) {
      if (await this.isCaptioned(channel, program)) {
        captioned.add(program.uuid);
      }
    }
    return captioned;
  }

  private channelDeliversHlsCaptions(channel: ChannelOrm): boolean {
    return (
      !!channel.subtitlesEnabled &&
      channel.subtitleDeliveryMethod === 'hls' &&
      CaptionedStreamModes.has(channel.streamMode) &&
      this.featureFlags.get('webvttSidecarEnabled')
    );
  }

  private loadPrograms(programIds: string[]) {
    return throttledAccumulate(
      chunk(uniq(programIds), ProgramBatchSize),
      (idChunk) =>
        this.drizzle.query.program.findMany({
          where: inArray(Program.uuid, idChunk),
          with: {
            externalIds: true,
            subtitles: true,
            versions: { with: { mediaStreams: true } },
          },
        }),
    );
  }

  private async isCaptioned(
    channel: ChannelOrm,
    program: StoredProgram,
  ): Promise<boolean> {
    const lineupItem = toLineupItem(program);
    const version = head(program.versions);
    if (!lineupItem || !version) {
      return false;
    }

    const streamsByKind = mediaStreamsByKind(version.mediaStreams);
    const audioStreams = (streamsByKind['audio'] ?? []).map(
      toAudioStreamDetails,
    );
    if (!isNonEmptyArray(audioStreams)) {
      return false;
    }
    const subtitleStreams = [
      ...(streamsByKind['subtitles'] ?? []).map(
        toEmbeddedSubtitleStreamDetails,
      ),
      ...storedSubtitleStreams(program.subtitles),
    ];

    const profile = await this.profileResolver.resolve({
      channelId: channel.uuid,
      programId: program.uuid,
    });
    const celContext = buildCelContext(
      audioStreams,
      subtitleStreams,
      { name: channel.name, number: channel.number },
      { title: program.title, type: program.type },
    );
    const { subtitleStream } = await evaluateStreamSelectionProfile(
      profile,
      audioStreams,
      subtitleStreams,
      this.celService,
      celContext,
      lineupItem,
      resolveExtractedText,
    );

    return isDeliveredAsHls(channel, subtitleStream);
  }
}

function toLineupItem(
  program: StoredProgram,
): ProgramStreamLineupItem | undefined {
  const { mediaSourceId } = program;
  if (!mediaSourceId) {
    return;
  }
  return {
    type: 'program',
    program: { ...program, mediaSourceId },
    infiniteLoop: false,
    duration: program.duration,
    streamDuration: program.duration,
    programBeginMs: 0,
  };
}

function storedSubtitleStreams(
  subtitles: ProgramSubtitles[],
): SubtitleStreamDetails[] {
  return subtitles.flatMap((subtitle) =>
    isUsableWithoutDiskCheck(subtitle) && isNonEmptyString(subtitle.path)
      ? [toStoredSubtitleStreamDetails(subtitle, subtitle.path)]
      : [],
  );
}

function isUsableWithoutDiskCheck(subtitle: ProgramSubtitles): boolean {
  return subtitle.subtitleType === 'sidecar' || !!subtitle.isExtracted;
}

function isDeliveredAsHls(
  channel: ChannelOrm,
  subtitleStream: SubtitleStreamDetails | null,
): boolean {
  return (
    !!subtitleStream &&
    !isImageBasedSubtitle(subtitleStream.codec) &&
    resolveSubtitleDelivery({
      channel,
      streamMode: channel.streamMode,
      subtitleStream,
    }) === 'hls'
  );
}
