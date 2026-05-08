import type { TranscodeConfig } from '@tunarr/types';
import { TranscodeConfigSchema } from '@tunarr/types/schemas';
import tmp from 'tmp-promise';
import { test as baseTest } from 'vitest';
import { bootstrapTunarr } from '../bootstrap.ts';
import { globalOptions, setGlobalOptions } from '../globals.ts';
import { DBAccess } from './DBAccess.ts';
import { TranscodeConfigDB } from './TranscodeConfigDB.ts';
import { DrizzleDBAccess } from './schema/index.ts';

type Fixture = {
  db: string;
  drizzle: DrizzleDBAccess;
  repo: TranscodeConfigDB;
};

const test = baseTest.extend<Fixture>({
  db: async ({}, use) => {
    const dbResult = await tmp.dir({ unsafeCleanup: true });
    setGlobalOptions({
      database: dbResult.path,
      log_level: 'info',
      verbose: 0,
    });
    await bootstrapTunarr(globalOptions(), ':memory:');
    await use(dbResult.path);
    await dbResult.cleanup();
  },
  drizzle: async ({ db: _ }, use) => {
    const conn = DBAccess.instance.getConnection(':memory:');
    await use(conn!.drizzle);
  },
  repo: async ({ drizzle }, use) => {
    await use(new TranscodeConfigDB(drizzle));
  },
});

const baseConfig = (
  overrides: Partial<Omit<TranscodeConfig, 'id'>> = {},
): Omit<TranscodeConfig, 'id'> => ({
  name: 'Aspect Mode Test',
  threadCount: 0,
  hardwareAccelerationMode: 'none',
  vaapiDriver: 'system',
  vaapiDevice: null,
  resolution: {
    widthPx: 1920,
    heightPx: 1080,
  },
  videoFormat: 'h264',
  videoProfile: null,
  videoPreset: null,
  videoBitDepth: 8,
  videoBitRate: 3500,
  videoBufferSize: 7000,
  aspectRatioMode: 'crop',
  audioChannels: 2,
  audioFormat: 'aac',
  audioBitRate: 192,
  audioBufferSize: 384,
  audioSampleRate: 48,
  audioVolumePercent: 100,
  audioLoudnormConfig: null,
  normalizeFrameRate: false,
  deinterlaceVideo: true,
  disableChannelOverlay: false,
  errorScreen: 'pic',
  errorScreenAudio: 'silent',
  isDefault: false,
  disableHardwareDecoder: false,
  disableHardwareEncoding: false,
  disableHardwareFilters: false,
  ...overrides,
});

describe('TranscodeConfigDB', () => {
  test('schema defaults aspectRatioMode to preserve for legacy payloads', () => {
    const parsed = TranscodeConfigSchema.parse({
      id: '6d032998-6c16-447f-8d9f-a73fcbf02d6e',
      ...baseConfig(),
      aspectRatioMode: undefined,
    });

    expect(parsed.aspectRatioMode).toBe('preserve');
  });

  test('creates, fetches, duplicates, and updates aspectRatioMode', async ({
    repo,
  }) => {
    const created = await repo.insertConfig(baseConfig());
    expect(created.aspectRatioMode).toBe('crop');

    const fetched = await repo.getById(created.uuid);
    expect(fetched?.aspectRatioMode).toBe('crop');

    const duplicated = await repo.duplicateConfig(created.uuid);
    expect(duplicated.isSuccess()).toBe(true);
    expect(duplicated.get().aspectRatioMode).toBe('crop');
    expect(duplicated.get().uuid).not.toBe(created.uuid);

    await repo.updateConfig(created.uuid, {
      id: created.uuid,
      ...baseConfig({ aspectRatioMode: 'stretch' }),
    });

    const updated = await repo.getById(created.uuid);
    expect(updated?.aspectRatioMode).toBe('stretch');
  });
});
