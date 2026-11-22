import type { FeatureFlags, FfmpegSettings } from '@tunarr/types';
import { tag } from '@tunarr/types';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import { describe, expect, test as baseTest } from 'vitest';
import { bootstrapTunarr } from '../bootstrap.ts';
import { DBAccess } from '../db/DBAccess.ts';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceId, MediaSourceName } from '../db/schema/base.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import { MediaSource } from '../db/schema/MediaSource.ts';
import { Program } from '../db/schema/Program.ts';
import type { NewProgramMediaStream } from '../db/schema/ProgramMediaStream.ts';
import { ProgramMediaStream } from '../db/schema/ProgramMediaStream.ts';
import type { NewProgramSubtitles } from '../db/schema/ProgramSubtitles.ts';
import { ProgramSubtitles } from '../db/schema/ProgramSubtitles.ts';
import type { ChannelSubtitlePreferences } from '../db/schema/SubtitlePreferences.ts';
import { ProgramVersion } from '../db/schema/ProgramVersion.ts';
import { StreamSelectionProfile } from '../db/schema/StreamSelectionProfile.ts';
import { globalOptions, setGlobalOptionsUnchecked } from '../globals.ts';
import { copyPreMigratedDb } from '../testing/testDbFactory.ts';
import { getSubtitleCacheFilePath } from '../util/subtitles.ts';
import { CelEvaluationService } from './CelEvaluationService.ts';
import { FeatureFlagService } from './FeatureFlagService.ts';
import { FileSystemService } from './FileSystemService.ts';
import { GuideCaptionService } from './GuideCaptionService.ts';
import { StreamSelectionProfileResolver } from './StreamSelectionProfileResolver.ts';

type Fixture = {
  db: string;
  drizzle: DrizzleDBAccess;
  cacheFolder: string;
};

const test = baseTest.extend<Fixture>({
  db: async ({}, use) => {
    const dbResult = await tmp.dir({ unsafeCleanup: true });
    await copyPreMigratedDb(dbResult.path);
    const opts = setGlobalOptionsUnchecked({
      database: dbResult.path,
      log_level: 'error',
      verbose: 0,
    });
    await bootstrapTunarr(opts);
    await use(dbResult.path);
    await DBAccess.instance.closeConnection(`${dbResult.path}/db.db`);
    await dbResult.cleanup();
  },
  drizzle: async ({ db: _ }, use) => {
    const drizzle = DBAccess.instance.drizzle;
    if (!drizzle) {
      throw new Error('Expected Drizzle DB connection to be initialized');
    }
    await use(drizzle);
  },
  cacheFolder: async ({ db: _ }, use) => {
    const folder = new FileSystemService(
      globalOptions(),
    ).getSubtitleCacheFolder();
    await fs.mkdir(folder, { recursive: true });
    await use(folder);
  },
});

type SeededProgram = {
  uuid: string;
  externalKey: string;
  mediaSourceId: MediaSourceId;
  sourceType: 'jellyfin';
  versionId: string;
};

function makeService(
  drizzle: DrizzleDBAccess,
  {
    webvttSidecarEnabled = true,
    allowImageBased = true,
    onSubtitlePreferences = () => {},
  }: {
    webvttSidecarEnabled?: boolean;
    allowImageBased?: boolean;
    onSubtitlePreferences?: () => void;
  } = {},
) {
  const settingsDB = {
    ffmpegSettings: () => ({}) as FfmpegSettings,
    featureFlags: () => ({ webvttSidecarEnabled }) as FeatureFlags,
  } as unknown as ISettingsDB;
  const channelDB = {
    getChannelSubtitlePreferences: () => {
      onSubtitlePreferences();
      return Promise.resolve([
        {
          uuid: v4(),
          channelId: 'channel-1',
          languageCode: 'eng',
          priority: 0,
          allowImageBased,
          allowExternal: true,
          filterType: 'any',
        } as ChannelSubtitlePreferences,
      ]);
    },
  } as unknown as IChannelDB;

  return new GuideCaptionService(
    drizzle,
    new StreamSelectionProfileResolver(drizzle, settingsDB, channelDB),
    new CelEvaluationService(),
    new FeatureFlagService(settingsDB),
    channelDB,
  );
}

function makeChannel(overrides: Partial<ChannelOrm> = {}): ChannelOrm {
  return {
    uuid: 'channel-1',
    name: 'Test Channel',
    number: 1,
    streamMode: 'hls',
    subtitlesEnabled: true,
    subtitleDeliveryMethod: 'hls',
    subtitleUnsupportedFallback: 'none',
    ...overrides,
  } as ChannelOrm;
}

function seedProgram(drizzle: DrizzleDBAccess): SeededProgram {
  const mediaSourceId = tag<MediaSourceId>(v4());
  drizzle
    .insert(MediaSource)
    .values({
      uuid: mediaSourceId,
      name: tag<MediaSourceName>(`Test Jellyfin ${mediaSourceId}`),
      type: 'jellyfin',
      uri: 'http://jellyfin.local:8096',
      index: 0,
      accessToken: 'token',
      mediaType: 'movies',
    })
    .run();

  const program = {
    uuid: v4(),
    duration: 30_000,
    type: 'movie' as const,
    sourceType: 'jellyfin' as const,
    externalKey: v4(),
    externalSourceId: tag<MediaSourceName>('test-source'),
    title: 'Test Movie',
    mediaSourceId,
  };
  drizzle.insert(Program).values(program).run();

  const versionId = v4();
  const now = new Date();
  drizzle
    .insert(ProgramVersion)
    .values({
      uuid: versionId,
      createdAt: now,
      updatedAt: now,
      duration: 30_000,
      scanKind: 'progressive',
      width: 1920,
      height: 1080,
      programId: program.uuid,
    })
    .run();

  return { ...program, versionId };
}

function insertStream(
  drizzle: DrizzleDBAccess,
  program: SeededProgram,
  values: Omit<NewProgramMediaStream, 'uuid' | 'programVersionId'>,
) {
  drizzle
    .insert(ProgramMediaStream)
    .values({ uuid: v4(), programVersionId: program.versionId, ...values })
    .run();
}

function insertAudio(drizzle: DrizzleDBAccess, program: SeededProgram) {
  insertStream(drizzle, program, {
    index: 1,
    codec: 'aac',
    streamKind: 'audio',
    language: 'eng',
    channels: 2,
    default: true,
  });
}

function insertEmbeddedSubtitle(
  drizzle: DrizzleDBAccess,
  program: SeededProgram,
  index: number,
  codec: string,
) {
  insertStream(drizzle, program, {
    index,
    codec,
    streamKind: 'subtitles',
    language: 'eng',
  });
}

function insertSubtitleRow(
  drizzle: DrizzleDBAccess,
  program: SeededProgram,
  values: Partial<NewProgramSubtitles>,
) {
  const now = new Date();
  drizzle
    .insert(ProgramSubtitles)
    .values({
      uuid: v4(),
      programId: program.uuid,
      createdAt: now,
      updatedAt: now,
      language: 'eng',
      subtitleType: 'sidecar',
      codec: 'subrip',
      ...values,
    })
    .run();
}

async function writeExtractedSubtitle(
  cacheFolder: string,
  program: SeededProgram,
  streamIndex: number,
  codec: string,
) {
  const relative = getSubtitleCacheFilePath(
    {
      id: program.uuid,
      externalKey: program.externalKey,
      externalSourceId: program.mediaSourceId,
      externalSourceType: program.sourceType,
    },
    { streamIndex, codec },
  );
  if (!relative) {
    throw new Error(`Expected a cache path for codec ${codec}`);
  }
  const fullPath = path.join(cacheFolder, relative);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, 'subtitle');
}

async function seedExtractedSrtProgram(
  drizzle: DrizzleDBAccess,
  cacheFolder: string,
) {
  const program = seedProgram(drizzle);
  insertAudio(drizzle, program);
  insertEmbeddedSubtitle(drizzle, program, 2, 'srt');
  await writeExtractedSubtitle(cacheFolder, program, 2, 'srt');
  return program;
}

function preferImageTracks(drizzle: DrizzleDBAccess, program: SeededProgram) {
  const profileId = v4();
  drizzle
    .insert(StreamSelectionProfile)
    .values({
      uuid: profileId,
      name: 'Prefer image tracks',
      rules: [
        {
          condition: 'true',
          audioAction: { type: 'default' },
          subtitleAction: {
            type: 'by_language',
            languages: ['eng'],
            filterType: 'any',
            allowImageBased: true,
            allowExternal: true,
          },
        },
      ],
    })
    .run();
  drizzle
    .update(Program)
    .set({ streamSelectionProfileId: profileId })
    .where(eq(Program.uuid, program.uuid))
    .run();
}

describe('GuideCaptionService', () => {
  test('captions a programme whose selected track is embedded srt and extracted', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = await seedExtractedSrtProgram(drizzle, cacheFolder);

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [program.uuid],
    );

    expect([...result]).toEqual([program.uuid]);
  });

  test('reads the channel subtitle preferences once per call, not per programme', async ({
    drizzle,
    cacheFolder,
  }) => {
    const first = await seedExtractedSrtProgram(drizzle, cacheFolder);
    const second = await seedExtractedSrtProgram(drizzle, cacheFolder);
    const third = await seedExtractedSrtProgram(drizzle, cacheFolder);
    let lookups = 0;

    const result = await makeService(drizzle, {
      onSubtitlePreferences: () => lookups++,
    }).captionedProgramIds(makeChannel(), [
      first.uuid,
      second.uuid,
      third.uuid,
    ]);

    expect(result.size).toBe(3);
    expect(lookups).toBe(1);
  });

  test('skips image-only tracks', async ({ drizzle, cacheFolder: _ }) => {
    const pgs = seedProgram(drizzle);
    insertAudio(drizzle, pgs);
    insertEmbeddedSubtitle(drizzle, pgs, 2, 'hdmv_pgs_subtitle');
    const vobsub = seedProgram(drizzle);
    insertAudio(drizzle, vobsub);
    insertEmbeddedSubtitle(drizzle, vobsub, 2, 'dvd_subtitle');

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [pgs.uuid, vobsub.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('skips everything when the channel burns subtitles', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = await seedExtractedSrtProgram(drizzle, cacheFolder);

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel({ subtitleDeliveryMethod: 'burn' }),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('skips everything when subtitles are off', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = await seedExtractedSrtProgram(drizzle, cacheFolder);

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel({ subtitlesEnabled: false }),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('skips everything for mpegts stream mode', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = await seedExtractedSrtProgram(drizzle, cacheFolder);

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel({ streamMode: 'mpegts' }),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('skips everything when the WebVTT sidecar feature flag is off', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = await seedExtractedSrtProgram(drizzle, cacheFolder);

    const result = await makeService(drizzle, {
      webvttSidecarEnabled: false,
    }).captionedProgramIds(makeChannel(), [program.uuid]);

    expect(result.size).toBe(0);
  });

  test('skips an embedded text track whose cache file is missing', async ({
    drizzle,
    cacheFolder: _,
  }) => {
    const program = seedProgram(drizzle);
    insertAudio(drizzle, program);
    insertEmbeddedSubtitle(drizzle, program, 2, 'srt');

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('captions a sidecar with a stored path', async ({
    drizzle,
    cacheFolder: _,
  }) => {
    const program = seedProgram(drizzle);
    insertAudio(drizzle, program);
    insertSubtitleRow(drizzle, program, { path: '/subs/movie.en.srt' });

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [program.uuid],
    );

    expect([...result]).toEqual([program.uuid]);
  });

  test('skips a sidecar with no stored path', async ({
    drizzle,
    cacheFolder: _,
  }) => {
    const program = seedProgram(drizzle);
    insertAudio(drizzle, program);
    insertSubtitleRow(drizzle, program, {
      sourcePath: '/media/movie.en.srt',
    });

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('skips a programme with no stored audio streams', async ({
    drizzle,
    cacheFolder,
  }) => {
    const program = seedProgram(drizzle);
    insertEmbeddedSubtitle(drizzle, program, 2, 'srt');
    await writeExtractedSubtitle(cacheFolder, program, 2, 'srt');

    const result = await makeService(drizzle).captionedProgramIds(
      makeChannel(),
      [program.uuid],
    );

    expect(result.size).toBe(0);
  });

  test('hls_direct_v2 captions a text track the selection profile passes over for an image track', async ({
    drizzle,
    cacheFolder: _,
  }) => {
    const program = seedProgram(drizzle);
    insertAudio(drizzle, program);
    insertEmbeddedSubtitle(drizzle, program, 2, 'hdmv_pgs_subtitle');
    insertEmbeddedSubtitle(drizzle, program, 3, 'srt');
    preferImageTracks(drizzle, program);
    const service = makeService(drizzle, { allowImageBased: false });

    const passthrough = await service.captionedProgramIds(
      makeChannel({ streamMode: 'hls_direct_v2' }),
      [program.uuid],
    );
    const transcoded = await service.captionedProgramIds(makeChannel(), [
      program.uuid,
    ]);

    expect([...passthrough]).toEqual([program.uuid]);
    expect(transcoded.size).toBe(0);
  });

  test('hls_direct_v2 captions even when the WebVTT sidecar feature flag is off', async ({
    drizzle,
    cacheFolder: _,
  }) => {
    const program = seedProgram(drizzle);
    insertAudio(drizzle, program);
    insertEmbeddedSubtitle(drizzle, program, 2, 'srt');

    const result = await makeService(drizzle, {
      webvttSidecarEnabled: false,
    }).captionedProgramIds(makeChannel({ streamMode: 'hls_direct_v2' }), [
      program.uuid,
    ]);

    expect([...result]).toEqual([program.uuid]);
  });
});
