import type {
  BreakCandidate,
  BreakDetectorConfig,
} from '@tunarr/types/schemas';
import { createHash } from 'node:crypto';

export const BREAK_DETECTOR_VERSION = 'conservative-fade-v1';
export const SAMPLE_MS = 100;
export type Interval = { startMs: number; endMs: number };
export type VideoSample = {
  mean: number;
  blackRatio: number;
  pixels: Uint8Array;
};
export type ExtractedFeatures = { video: VideoSample[]; audioDb: number[] };

export function configurationHash(
  config: BreakDetectorConfig,
  video?: number,
  audio?: number,
) {
  return createHash('sha256')
    .update(JSON.stringify({ config, video, audio }))
    .digest('hex');
}

export function pixelDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
}

function intervals(values: boolean[]): Interval[] {
  const result: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    if (values[i] && start < 0) start = i;
    if (!values[i] && start >= 0) {
      result.push({ startMs: start * SAMPLE_MS, endMs: i * SAMPLE_MS });
      start = -1;
    }
  }
  return result;
}

const average = (v: number[]) =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;

export function evaluateBreaks(
  features: ExtractedFeatures,
  runtimeMs: number,
  config: BreakDetectorConfig,
  exclusions: Interval[] = [],
): BreakCandidate[] {
  const { video, audioDb } = features;
  const black = intervals(video.map((v) => v.blackRatio >= config.blackRatio));
  const silence = intervals(audioDb.map((v) => v <= config.silenceDb)).filter(
    (v) => v.endMs - v.startMs >= config.minSilenceMs,
  );
  const guards = [
    ...exclusions,
    {
      startMs: 0,
      endMs: Math.max(
        config.startExclusionMs,
        runtimeMs * config.startExclusionFraction,
      ),
    },
    {
      startMs:
        runtimeMs -
        Math.max(
          config.endExclusionMs,
          runtimeMs * config.endExclusionFraction,
        ),
      endMs: runtimeMs,
    },
  ];
  let silenceIndex = 0;
  const candidates = black.map((event): BreakCandidate => {
    const start = Math.round(event.startMs / SAMPLE_MS);
    const end = Math.round(event.endMs / SAMPLE_MS);
    const context = Math.round(config.contextMs / SAMPLE_MS);
    const completeContext =
      start >= context &&
      end + context <= video.length &&
      end + context <= audioDb.length;
    const before = video.slice(
      Math.max(0, start - context),
      Math.max(0, start - 10),
    );
    const after = video.slice(end + 10, end + context);
    const motion = (samples: VideoSample[]) =>
      average(
        samples
          .slice(1)
          .map((v, i) => pixelDifference(v.pixels, samples[i]!.pixels)),
      );
    const motionBefore = motion(before);
    const motionAfter = motion(after);
    // Require different imagery at several offsets, not merely at the cut to black.
    const differences = [20, 40, 60].map((offset) => {
      const a = video[start - offset];
      const b = video[end + offset];
      return a && b ? pixelDifference(a.pixels, b.pixels) : 0;
    });
    const visualDifference = Math.min(...differences);
    const fadeSamples = video
      .slice(Math.max(0, start - 8), start)
      .map((v) => v.mean);
    const descending = fadeSamples
      .slice(1)
      .filter((v, i) => v < fadeSamples[i]! - 0.005).length;
    const fade =
      fadeSamples.length === 8 &&
      descending >= 4 &&
      fadeSamples[0]! - fadeSamples[7]! >= 0.12;
    const audioWindow = (from: number, to: number) => {
      const samples = audioDb.slice(Math.max(0, from), Math.max(0, to));
      return (
        samples.length > 0 &&
        samples.filter((v) => v > config.silenceDb + 10).length /
          samples.length >=
          0.6
      );
    };
    const audioContext =
      audioWindow(start - context, start - 10) &&
      audioWindow(end + 10, end + context);
    while (
      silenceIndex < silence.length &&
      silence[silenceIndex]!.endMs <= event.startMs
    )
      silenceIndex++;
    let overlap: Interval | undefined;
    for (
      let i = silenceIndex;
      i < silence.length && silence[i]!.startMs < event.endMs;
      i++
    ) {
      const s = silence[i]!;
      const intersection = {
        startMs: Math.max(s.startMs, event.startMs),
        endMs: Math.min(s.endMs, event.endMs),
      };
      if (
        !overlap ||
        intersection.endMs - intersection.startMs >
          overlap.endMs - overlap.startMs
      )
        overlap = intersection;
    }
    const silenceOverlapMs = overlap ? overlap.endMs - overlap.startMs : 0;
    const timestampMs = Math.round(
      overlap
        ? (overlap.startMs + overlap.endMs) / 2
        : (event.startMs + event.endMs) / 2,
    );
    const reasons: string[] = [];
    const duration = event.endMs - event.startMs;
    if (duration < config.minBlackMs || duration > config.maxBlackMs)
      reasons.push('black-duration');
    if (silenceOverlapMs < config.minSilenceMs)
      reasons.push('insufficient-silence-overlap');
    if (!fade) reasons.push('no-fade');
    if (!completeContext) reasons.push('incomplete-context');
    if (!audioContext) reasons.push('silent-surroundings');
    if (visualDifference < config.visualDifference)
      reasons.push('scene-continuity');
    if (motionBefore < config.minMotion || motionAfter < config.minMotion)
      reasons.push('static-context');
    if (
      before.some((v) => v.blackRatio >= config.blackRatio) ||
      after.some((v) => v.blackRatio >= config.blackRatio)
    )
      reasons.push('dark-context');
    if (
      guards.some((g) => event.startMs <= g.endMs && event.endMs >= g.startMs)
    )
      reasons.push('excluded-region');
    return {
      timestampMs,
      confidence:
        reasons.length === 0 ? 'high' : silenceOverlapMs > 0 ? 'medium' : 'low',
      accepted: reasons.length === 0,
      reasons,
      evidence: {
        blackStartMs: event.startMs,
        blackEndMs: event.endMs,
        silenceOverlapMs,
        fade,
        visualDifference,
        motionBefore,
        motionAfter,
        audioContext,
        completeContext,
      },
    };
  });
  // Bound the entire cluster span; chained detections cannot bridge unrelated transitions.
  const clusters: BreakCandidate[][] = [];
  for (const candidate of candidates) {
    const last = clusters.at(-1);
    if (
      last &&
      candidate.timestampMs - last[0]!.timestampMs <= config.clusterMs
    )
      last.push(candidate);
    else clusters.push([candidate]);
  }
  const rank = (a: BreakCandidate, b: BreakCandidate) =>
    Number(b.accepted) - Number(a.accepted) ||
    a.reasons.length - b.reasons.length ||
    b.evidence.visualDifference - a.evidence.visualDifference ||
    a.timestampMs - b.timestampMs;
  const collapsed = clusters.map((c) => c.sort(rank)[0]!);
  const cap =
    config.runtimeCaps.find((c) => runtimeMs < c.belowMs)?.maxBreaks ??
    config.runtimeCaps.at(-1)!.maxBreaks;
  const selected: BreakCandidate[] = [];
  for (const c of collapsed.filter((c) => c.accepted).sort(rank)) {
    const reason = selected.some(
      (s) => Math.abs(s.timestampMs - c.timestampMs) < config.minimumSpacingMs,
    )
      ? 'minimum-spacing'
      : selected.length >= cap
        ? 'runtime-cap'
        : undefined;
    if (reason) {
      c.accepted = false;
      c.reasons.push(reason);
    } else selected.push(c);
  }
  return collapsed.sort((a, b) => a.timestampMs - b.timestampMs);
}
