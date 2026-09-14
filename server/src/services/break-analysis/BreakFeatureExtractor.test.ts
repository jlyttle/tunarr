import { BreakDetectorConfigSchema } from '@tunarr/types/schemas';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FileStreamSource } from '../../stream/types.ts';
import { BreakFeatureExtractor } from './BreakFeatureExtractor.ts';
import { evaluateBreaks } from './BreakDetector.ts';

const available =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const config = BreakDetectorConfigSchema.parse({
  startExclusionMs: 0,
  startExclusionFraction: 0,
  endExclusionMs: 0,
  endExclusionFraction: 0,
  runtimeCaps: [{ belowMs: 100000, maxBreaks: 1 }],
});
describe.skipIf(!available)(
  'FFmpeg feature extraction with generated media',
  () => {
    let directory: string;
    let file: string;
    const extractor = new BreakFeatureExtractor('ffmpeg', 'ffprobe');
    const options = { timeoutMs: 30000, threads: 1 };
    beforeAll(async () => {
      directory = await mkdtemp(path.join(os.tmpdir(), 'tunarr-break-test-'));
      file = path.join(directory, 'episode.mkv');
      const generation = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x90:rate=10:duration=20',
          '-f',
          'lavfi',
          '-i',
          'color=black:size=160x90:rate=10:duration=0.6',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x90:rate=10:duration=20',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=8000:duration=40.6',
          '-filter_complex',
          "[0:v]fade=t=out:st=19.2:d=0.8[a];[2:v]negate[b];[a][1:v][b]concat=n=3:v=1:a=0[v];[3:a]volume=0:enable='between(t,20,20.6)'[audio]",
          '-map',
          '[v]',
          '-map',
          '[audio]',
          '-c:v',
          'ffv1',
          '-c:a',
          'pcm_s16le',
          file,
        ],
        { timeout: 30000 },
      );
      if (generation.status !== 0)
        throw new Error(generation.stderr.toString());
    }, 35000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    test('finds the real generated transition and leaves source bytes unchanged', async () => {
      const { stat, readFile } = await import('node:fs/promises');
      const { createHash } = await import('node:crypto');
      const before = await stat(file);
      const digest = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
      const { features } = await extractor.extract(
        new FileStreamSource(file),
        40600,
        config,
        options,
      );
      expect(features.video.length).toBeGreaterThan(400);
      const accepted = evaluateBreaks(features, 40600, config).filter(
        (c) => c.accepted,
      );
      expect(
        accepted,
        JSON.stringify(evaluateBreaks(features, 40600, config)),
      ).toHaveLength(1);
      expect(Math.abs(accepted[0]!.timestampMs - 20300)).toBeLessThanOrEqual(
        2000,
      );
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
      expect(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ).toBe(digest);
    }, 35000);
    test('rejects a mismatched runtime and missing audio stream', async () => {
      await expect(
        extractor.extract(new FileStreamSource(file), 90000, config, options),
      ).rejects.toThrow('runtime-mismatch');
      await expect(
        extractor.extract(new FileStreamSource(file), 40600, config, {
          ...options,
          audioStreamIndex: 99,
        }),
      ).rejects.toThrow('unsupported-stream-selection');
    });
    test('supports cancellation without exposing input paths', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        extractor.extract(
          new FileStreamSource('/private/secret.mkv'),
          40600,
          config,
          { ...options, signal: controller.signal },
        ),
      ).rejects.toThrow('cancelled');
      await expect(
        extractor.extract(
          new FileStreamSource('/private/secret.mkv'),
          40600,
          config,
          options,
        ),
      ).rejects.toThrow('decode-failed');
    });
    test('normalizes nonzero media timestamps to episode-relative time', async () => {
      const offsetFile = path.join(directory, 'offset.mkv');
      expect(
        spawnSync('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-i',
          file,
          '-c',
          'copy',
          '-output_ts_offset',
          '7',
          offsetFile,
        ]).status,
      ).toBe(0);
      const { features } = await extractor.extract(
        new FileStreamSource(offsetFile),
        40600,
        config,
        options,
      );
      const accepted = evaluateBreaks(features, 40600, config).filter(
        (c) => c.accepted,
      );
      expect(accepted).toHaveLength(1);
      expect(Math.abs(accepted[0]!.timestampMs - 20300)).toBeLessThanOrEqual(
        2000,
      );
    });
    test('samples variable-frame-rate media using timestamps', async () => {
      const variableFile = path.join(directory, 'variable.mkv');
      expect(
        spawnSync('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-i',
          file,
          '-vf',
          "select='if(lt(t,10),not(mod(n,3)),1)'",
          '-fps_mode',
          'vfr',
          '-c:v',
          'ffv1',
          '-c:a',
          'copy',
          variableFile,
        ]).status,
      ).toBe(0);
      const { features } = await extractor.extract(
        new FileStreamSource(variableFile),
        40600,
        config,
        options,
      );
      const accepted = evaluateBreaks(features, 40600, config).filter(
        (c) => c.accepted,
      );
      expect(accepted).toHaveLength(1);
      expect(Math.abs(accepted[0]!.timestampMs - 20300)).toBeLessThanOrEqual(
        2000,
      );
    });
    test('rejects truncated decoding and cancels an in-flight process', async () => {
      const { readFile, writeFile } = await import('node:fs/promises');
      const contents = await readFile(file);
      const truncatedFile = path.join(directory, 'truncated.mkv');
      await writeFile(
        truncatedFile,
        contents.subarray(0, Math.floor(contents.length / 2)),
      );
      await expect(
        extractor.extract(
          new FileStreamSource(truncatedFile),
          40600,
          config,
          options,
        ),
      ).rejects.toThrow();
      const controller = new AbortController();
      const pending = extractor.extract(
        new FileStreamSource(file),
        40600,
        config,
        { ...options, signal: controller.signal },
      );
      const timer = setTimeout(() => controller.abort(), 10);
      await expect(pending).rejects.toThrow('cancelled');
      clearTimeout(timer);
    });
  },
);
