import { setGlobalOptionsUnchecked } from '@/globals.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp-promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceDB } from '../db/mediaSourceDB.ts';
import {
  HlsOutputFormat,
  defaultHlsOptions,
} from '../ffmpeg/builder/constants.ts';
import type { FFmpegAssistedFactory } from '../ffmpeg/FFmpegModule.ts';
import type {
  StreamSessionCreateArgs,
  TranscodeSessionResult,
} from '../ffmpeg/types.ts';
import type { CacheImageService } from '../services/cacheImageService.ts';
import { Result } from '../types/result.ts';
import type { PlayerContext } from './PlayerStreamContext.ts';
import { ProgramStream } from './ProgramStream.ts';
import type { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';

class ThrowingProgramStream extends ProgramStream {
  protected override setupInternal(): Promise<Result<TranscodeSessionResult>> {
    return Promise.reject(
      new Error('Streams with no video are not currently supported.'),
    );
  }
}

describe('ProgramStream', () => {
  it('turns a setup throw into a failed result', async () => {
    const stream = new ThrowingProgramStream(
      {} as ISettingsDB,
      {} as CacheImageService,
      {} as FFmpegAssistedFactory,
      {} as MediaSourceDB,
      {} as ProgramStreamDetailsFetcher,
      [],
      {} as PlayerContext,
      HlsOutputFormat(defaultHlsOptions),
    );

    const result = await stream.setup();

    expect(result.isFailure()).toBe(true);
    expect(stream.isInitialized()).toBe(false);
  });
});

describe('ProgramStream music video labels', () => {
  let databaseDir: tmp.DirectoryResult;

  beforeEach(async () => {
    databaseDir = await tmp.dir({ unsafeCleanup: true });
    setGlobalOptionsUnchecked({
      database: databaseDir.path,
      log_level: 'error',
      verbose: 0,
    });
  });

  afterEach(() => databaseDir.cleanup());

  async function installFont() {
    const fontDir = path.join(databaseDir.path, 'fonts');
    await mkdir(fontDir, { recursive: true });
    await writeFile(path.join(fontDir, 'KabelBlack.ttf'), '');
  }

  function musicVideo(overrides: Record<string, unknown> = {}) {
    return {
      type: 'music_video',
      title: "I Ain't Mad At Cha",
      artistName: '2Pac',
      albumName: 'All Eyez On Me',
      duration: 240_000,
      mediaSourceId: 'source',
      externalIds: [],
      studios: [{ studio: { name: 'Death Row' } }],
      credits: [],
      tags: [],
      ...overrides,
    };
  }

  async function streamOptions({
    musicVideoLabels = true,
    program = musicVideo(),
    startOffset = 0,
  }: {
    musicVideoLabels?: boolean;
    program?: Record<string, unknown>;
    startOffset?: number;
  } = {}) {
    const createStreamSession = vi.fn((_args: StreamSessionCreateArgs) =>
      Promise.resolve({ session: { on: vi.fn() }, renditions: {} }),
    );
    const warn = vi.fn();
    const lineupItem = {
      type: 'program',
      program,
      startOffset,
      streamDuration: 240_000 - startOffset,
      infiniteLoop: false,
    };
    const stream = new ProgramStream(
      {} as ISettingsDB,
      {} as CacheImageService,
      (() => ({ createStreamSession })) as unknown as FFmpegAssistedFactory,
      {
        getById: () => Promise.resolve({}),
      } as unknown as MediaSourceDB,
      {
        getStream: () =>
          Promise.resolve(
            Result.success({ streamDetails: {}, streamSource: {} }),
          ),
      } as unknown as ProgramStreamDetailsFetcher,
      [],
      {
        lineupItem,
        targetChannel: { musicVideoLabels },
        sourceChannel: {},
        transcodeConfig: { disableChannelOverlay: true },
      } as unknown as PlayerContext,
      HlsOutputFormat(defaultHlsOptions),
    );
    Reflect.set(stream, 'logger', { warn } as unknown as Logger);

    const result = await stream.setup();
    expect(result.isSuccess()).toBe(true);
    return {
      label: createStreamSession.mock.calls[0]?.[0].options.musicVideoLabel,
      warn,
    };
  }

  it('passes the label spec and font for a music video on a labelled channel', async () => {
    await installFont();

    const { label, warn } = await streamOptions();

    expect(label).toEqual({
      lines: ['2Pac', '"I Ain\'t Mad At Cha"', 'All Eyez On Me', 'Death Row'],
      windows: [
        [5, 13],
        [220, 240],
      ],
      fontFile: path.join(databaseDir.path, 'fonts', 'KabelBlack.ttf'),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('shifts windows by the start offset against the full video duration', async () => {
    await installFont();

    const { label } = await streamOptions({ startOffset: 10_000 });

    expect(label?.windows).toEqual([
      [0, 3],
      [210, 230],
    ]);
  });

  it('draws no label when the channel flag is off', async () => {
    await installFont();

    const { label } = await streamOptions({ musicVideoLabels: false });

    expect(label).toBeUndefined();
  });

  it('draws no label for items that are not music videos', async () => {
    await installFont();

    const { label } = await streamOptions({
      program: musicVideo({ type: 'movie' }),
    });

    expect(label).toBeUndefined();
  });

  it('warns once and draws no label when the font is missing', async () => {
    const { label, warn } = await streamOptions();

    expect(label).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
