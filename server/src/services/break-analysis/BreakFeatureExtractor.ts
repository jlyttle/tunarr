import type { BreakDetectorConfig } from '@tunarr/types/schemas';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { z } from 'zod/v4';
import type { StreamSource } from '../../stream/types.ts';
import type { ExtractedFeatures } from './BreakDetector.ts';

const ProbeSchema = z.object({
  format: z.object({
    duration: z.coerce.number().positive(),
    start_time: z.coerce.number().default(0),
  }),
  streams: z.array(
    z.object({
      index: z.number().int(),
      codec_type: z.string(),
      channels: z.number().optional(),
      start_time: z.coerce.number().optional(),
      disposition: z
        .object({
          default: z.number().optional(),
          attached_pic: z.number().optional(),
          comment: z.number().optional(),
        })
        .optional(),
      tags: z.object({ title: z.string().optional() }).optional(),
    }),
  ),
  chapters: z
    .array(
      z.object({ start_time: z.coerce.number(), end_time: z.coerce.number() }),
    )
    .default([]),
});

export type ExtractionOptions = {
  timeoutMs: number;
  threads: number;
  videoStreamIndex?: number;
  audioStreamIndex?: number;
  signal?: AbortSignal;
};

// Never expose process arguments, stderr, URLs, or underlying errors to callers.
export class AnalysisError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function inputArguments(source: StreamSource): string[] {
  if (source.type !== 'file' && source.type !== 'http')
    throw new AnalysisError('unsupported-source');
  if (source.type === 'file') return ['-i', source.path];
  const headers = Object.entries(source.extraHeaders);
  if (headers.some(([k, v]) => /[\r\n]/.test(k + v)))
    throw new AnalysisError('invalid-headers');
  return [
    '-rw_timeout',
    '30000000',
    ...(headers.length
      ? ['-headers', headers.map(([k, v]) => `${k}: ${v}\r\n`).join('')]
      : []),
    '-i',
    source.path,
  ];
}

async function runProcess(
  executable: string,
  args: string[],
  options: ExtractionOptions,
  consume: (
    proc: ReturnType<typeof spawn>,
    fail: (code: string) => void,
  ) => void,
): Promise<void> {
  if (options.signal?.aborted) throw new AnalysisError('cancelled');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let error: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string) => {
      error ??= code;
      proc.kill('SIGTERM');
      killTimer ??= setTimeout(() => proc.kill('SIGKILL'), 2000);
    };
    const abort = () => fail('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => fail('analysis-timeout'),
      options.timeoutMs,
    );
    // Draining stderr prevents deadlocks without retaining credential-bearing output.
    proc.stderr?.resume();
    proc.on('error', () => {
      error ??= 'process-unavailable';
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error || code !== 0)
        reject(new AnalysisError(error ?? 'decode-failed'));
      else resolve();
    });
    try {
      consume(proc, fail);
    } catch {
      fail('feature-extraction-failed');
    }
    if (options.signal?.aborted) abort();
  });
}

export class BreakFeatureExtractor {
  constructor(
    private readonly ffmpeg: string,
    private readonly ffprobe: string,
  ) {}

  async probe(source: StreamSource, options: ExtractionOptions) {
    let output = '';
    await runProcess(
      this.ffprobe,
      [
        '-v',
        'error',
        ...inputArguments(source),
        '-show_format',
        '-show_streams',
        '-show_chapters',
        '-of',
        'json',
      ],
      { ...options, timeoutMs: Math.min(options.timeoutMs, 30000) },
      (proc, fail) => {
        proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
          if (output.length + chunk.length > 4 * 1024 * 1024)
            fail('probe-output-limit');
          else output += chunk;
        });
      },
    );
    let parsed: z.infer<typeof ProbeSchema>;
    try {
      parsed = ProbeSchema.parse(JSON.parse(output));
    } catch {
      throw new AnalysisError('invalid-media-metadata');
    }
    const video = parsed.streams
      .filter(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
      )
      .sort(
        (a, b) =>
          (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0) ||
          a.index - b.index,
      );
    const audio = parsed.streams
      .filter((s) => s.codec_type === 'audio')
      .sort(
        (a, b) =>
          (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0) ||
          a.index - b.index,
      );
    const selectedVideo =
      options.videoStreamIndex === undefined
        ? video[0]
        : video.find((s) => s.index === options.videoStreamIndex);
    const selectedAudio =
      options.audioStreamIndex === undefined
        ? audio.find(
            (s) =>
              !s.disposition?.comment &&
              !/commentary/i.test(s.tags?.title ?? ''),
          )
        : audio.find((s) => s.index === options.audioStreamIndex);
    if (
      !selectedVideo ||
      !selectedAudio ||
      !selectedAudio.channels ||
      selectedAudio.channels > 8
    )
      throw new AnalysisError('unsupported-stream-selection');
    if (
      [selectedVideo, selectedAudio].some(
        (s) =>
          Math.abs(
            (s.start_time ?? parsed.format.start_time) -
              parsed.format.start_time,
          ) > 1,
      )
    ) {
      throw new AnalysisError('unsupported-stream-offset');
    }
    return {
      ...parsed,
      video: selectedVideo,
      audio: selectedAudio,
      channels: selectedAudio.channels,
    };
  }

  async extract(
    source: StreamSource,
    runtimeMs: number,
    config: BreakDetectorConfig,
    options: ExtractionOptions,
  ) {
    if (!Number.isFinite(runtimeMs) || runtimeMs <= 0 || runtimeMs > 14400000)
      throw new AnalysisError('unsupported-runtime');
    const started = Date.now();
    const probe = await this.probe(source, options);
    if (
      // Some containers report the final timestamp as duration when start_time is nonzero.
      Math.min(
        ...[
          probe.format.duration,
          probe.format.duration - probe.format.start_time,
        ].map((seconds) => Math.abs(seconds * 1000 - runtimeMs)),
      ) > Math.max(2000, runtimeMs * 0.01)
    )
      throw new AnalysisError('runtime-mismatch');
    const origin = probe.format.start_time;
    const features: ExtractedFeatures = { video: [], audioDb: [] };
    const maxSamples = Math.ceil(runtimeMs / 100) + 20;
    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-copyts',
      '-threads',
      String(options.threads),
      ...inputArguments(source),
      '-filter_threads',
      String(options.threads),
      '-map',
      `0:${probe.video.index}`,
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `setpts=PTS-(${origin})/TB,fps=10:start_time=0,scale=32:18:flags=area,format=gray`,
      '-threads',
      String(options.threads),
      '-f',
      'rawvideo',
      'pipe:3',
      '-map',
      `0:${probe.audio.index}`,
      '-vn',
      '-sn',
      '-dn',
      '-af',
      `asetpts=PTS-(${origin})/TB,aresample=8000:async=1:first_pts=0`,
      '-threads',
      String(options.threads),
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:4',
    ];
    await runProcess(
      this.ffmpeg,
      args,
      {
        ...options,
        timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - started)),
      },
      (proc, fail) => {
        proc.stdout?.resume();
        const frames = (
          stream: Readable,
          size: number,
          cb: (frame: Buffer) => void,
        ) => {
          let pending = Buffer.alloc(0);
          stream.on('data', (chunk: Buffer) => {
            const data = pending.length
              ? Buffer.concat([pending, chunk])
              : chunk;
            let offset = 0;
            while (offset + size <= data.length) {
              cb(data.subarray(offset, offset + size));
              offset += size;
            }
            pending = Buffer.from(data.subarray(offset));
          });
          stream.on('error', () => fail('feature-pipe-failed'));
        };
        frames(proc.stdio[3] as Readable, 32 * 18, (frame) => {
          if (features.video.length >= maxSamples) {
            fail('feature-output-limit');
            return;
          }
          let sum = 0,
            black = 0;
          for (const v of frame) {
            sum += v;
            if (v / 255 <= config.blackPixelThreshold) black++;
          }
          features.video.push({
            mean: sum / frame.length / 255,
            blackRatio: black / frame.length,
            pixels: Uint8Array.from(frame),
          });
        });
        frames(proc.stdio[4] as Readable, 800 * probe.channels * 4, (frame) => {
          if (features.audioDb.length >= maxSamples) {
            fail('feature-output-limit');
            return;
          }
          // Measure each channel independently; downmix cancellation must never imply silence.
          const sums = new Array<number>(probe.channels).fill(0);
          for (let i = 0; i < frame.length / 4; i++) {
            const value = frame.readFloatLE(i * 4);
            if (!Number.isFinite(value)) {
              fail('invalid-audio-sample');
              return;
            }
            sums[i % probe.channels]! += value * value;
          }
          features.audioDb.push(
            10 * Math.log10(Math.max(1e-12, ...sums.map((s) => s / 800))),
          );
        });
      },
    );
    if (
      [features.video.length, features.audioDb.length].some(
        (n) => Math.abs(n * 100 - runtimeMs) > Math.max(2000, runtimeMs * 0.01),
      )
    ) {
      throw new AnalysisError('incomplete-decode');
    }
    return { features, probe };
  }
}
