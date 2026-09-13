import { nullToUndefined, seq } from '@tunarr/shared/util';
import dayjs from 'dayjs';
import { inject, injectable } from 'inversify';
import { groupBy, head, isEmpty, mapValues, orderBy } from 'lodash-es';
import { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import { KEYS } from '../types/inject.ts';
import { Result } from '../types/result.ts';
import { fileExists } from '../util/fsUtil.ts';
import { isNonEmptyArray, isNonEmptyString } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import { Logger } from '../util/logging/LoggerFactory.ts';
import { StreamFetchRequest } from './ExternalStreamDetailsFetcher.ts';
import { resolveProgramStreamSource } from './resolveProgramStreamSource.ts';
import {
  AudioStreamDetails,
  ProgramStreamResult,
  StreamDetails,
  StreamSource,
  SubtitleStreamDetails,
  VideoStreamDetails,
} from './types.ts';
import { extractIsAnamorphic } from './util.ts';

@injectable()
export class ProgramStreamDetailsFetcher {
  @InjectLogger() declare private readonly logger: Logger;

  constructor(@inject(KEYS.ProgramDB) private programDB: IProgramDB) {}

  async getStream({
    lineupItem,
    server,
  }: StreamFetchRequest): Promise<Result<ProgramStreamResult>> {
    const program = await this.programDB.getProgramById(lineupItem.uuid);

    if (!program) {
      return Result.forError(
        new Error(
          `Could not find program with ID ${lineupItem.uuid} when trying to start stream! This is bad!`,
        ),
      );
    }

    const firstVersion = head(program.versions);

    if (!firstVersion) {
      // TODO: Backfill these on the spot
      return Result.forError(
        new Error(`Program with ID ${lineupItem.uuid} Has no media versions.`),
      );
    }

    const streamsByType = mapValues(
      groupBy(firstVersion.mediaStreams ?? [], (stream) => stream.streamKind),
      (streams) => orderBy(streams, (stream) => stream.index, 'asc'),
    );

    const displayAspectRatio =
      firstVersion.displayAspectRatio ??
      `${firstVersion.width}/${firstVersion.height}`;
    const videoStreamDetails =
      streamsByType['video']?.map(
        (videoStream) =>
          ({
            displayAspectRatio,
            height: firstVersion.height,
            sampleAspectRatio: nullToUndefined(firstVersion.sampleAspectRatio),
            width: firstVersion.width,
            anamorphic: extractIsAnamorphic(
              firstVersion.width,
              firstVersion.height,
              displayAspectRatio,
            ),
            bitDepth: nullToUndefined(videoStream.bitsPerSample),
            codec: videoStream.codec,
            framerate: nullToUndefined(firstVersion.frameRate),
            profile: nullToUndefined(videoStream.profile),
            scanType: nullToUndefined(firstVersion.scanKind),
            streamIndex: videoStream.index,
            pixelFormat: nullToUndefined(videoStream.pixelFormat),
            bitrate: undefined,
            isAttachedPic: false,
            colorRange: videoStream.colorRange ?? undefined,
            colorSpace: videoStream.colorSpace ?? undefined,
            colorTransfer: videoStream.colorTransfer ?? undefined,
            colorPrimaries: videoStream.colorPrimaries ?? undefined,
          }) satisfies VideoStreamDetails,
      ) ?? [];

    const audioStreamDetails =
      streamsByType['audio']?.map(
        (audioStream) =>
          ({
            channels: nullToUndefined(audioStream.channels),
            codec: audioStream.codec,
            default: audioStream.default,
            forced: audioStream.forced,
            index: audioStream.index,
            languageCodeISO6392: nullToUndefined(audioStream.language),
            profile: nullToUndefined(audioStream.profile),
            title: nullToUndefined(audioStream.title),
          }) satisfies AudioStreamDetails,
      ) ?? [];

    const subtitleStreamDetails: SubtitleStreamDetails[] =
      streamsByType['subtitles']?.map(
        (subtitle) =>
          ({
            codec: subtitle.codec,
            default: subtitle.default,
            forced: subtitle.forced,
            sdh: false, // TODO:
            type: 'embedded',
            index: subtitle.index,
            languageCodeISO6392: nullToUndefined(subtitle.language),
          }) satisfies SubtitleStreamDetails,
      ) ?? [];

    const usableSubtitles = await Promise.all(
      (program.subtitles ?? []).map(async (subtitle) => {
        const pathOnDisk =
          isNonEmptyString(subtitle.path) && (await fileExists(subtitle.path));
        if (subtitle.subtitleType === 'sidecar') {
          return pathOnDisk ? subtitle : null;
        }
        if (!subtitle.isExtracted) {
          return null;
        }
        if (!pathOnDisk) {
          this.logger.debug(
            'Clearing isExtracted flag for program %s subtitle %s: file missing on disk (%s)',
            program.uuid,
            subtitle.uuid,
            subtitle.path ?? '<no path>',
          );
          await this.programDB.clearExtractedSubtitle(subtitle.uuid);
          return null;
        }
        return subtitle;
      }),
    );

    subtitleStreamDetails.push(
      ...seq.collect(usableSubtitles, (subtitle) => {
        if (!subtitle) return null;
        return {
          ...subtitle,
          index: nullToUndefined(subtitle.streamIndex),
          type: subtitle.subtitleType === 'embedded' ? 'embedded' : 'external',
          languageCodeISO6392: subtitle.language,
          sdh: subtitle.sdh,
          path: nullToUndefined(subtitle.path),
        } satisfies SubtitleStreamDetails;
      }),
    );

    const streamDetails: StreamDetails = {
      audioDetails: isNonEmptyArray(audioStreamDetails)
        ? audioStreamDetails
        : undefined,
      audioOnly: isEmpty(videoStreamDetails) && !isEmpty(audioStreamDetails),
      chapters: firstVersion.chapters,
      duration: dayjs.duration(firstVersion.duration),
      subtitleDetails: isNonEmptyArray(subtitleStreamDetails)
        ? subtitleStreamDetails
        : undefined,
      videoDetails: isNonEmptyArray(videoStreamDetails)
        ? videoStreamDetails
        : undefined,
    };

    if (server.type === 'local') {
      const file = head(firstVersion.mediaFiles);
      if (!file) {
        return Result.forError(
          new Error(`Program ID has no media files: ${program.uuid}`),
        );
      }

      const streamSource: StreamSource = {
        type: 'file',
        path: file.path,
      };

      return Result.success({ streamDetails, streamSource });
    } else {
      const filePath = head(firstVersion.mediaFiles)?.path;
      const serverPath = // details.serverPath ??
        program.externalIds.find(
          (eid) => eid.sourceType === server.type,
        )?.externalFilePath;
      const streamSource = await resolveProgramStreamSource(
        server,
        filePath,
        serverPath,
      );
      return Result.success({ streamDetails, streamSource });
    }
  }
}
