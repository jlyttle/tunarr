import type {
  BreakCandidate,
  BreakDetectorConfig,
} from '@tunarr/types/schemas';
import { createHash } from 'node:crypto';

export const BREAK_DETECTOR_VERSION = 'conservative-fade-v6';
export const SAMPLE_MS = 100;
export type Interval = { startMs: number; endMs: number };
export type VideoSample = {
  mean: number;
  blackRatio: number;
  pixels: Uint8Array;
};
export type ExtractedFeatures = {
  video: VideoSample[];
  audioDb: number[];
  startMs?: number;
};

export function breakScanWindow(
  runtimeMs: number,
  config: BreakDetectorConfig,
): Interval {
  // Align inward to the sampling grid; no samples belong to protected regions.
  const startMs = Math.min(
    runtimeMs,
    Math.ceil(Math.max(240000, config.startExclusionMs) / SAMPLE_MS) *
      SAMPLE_MS,
  );
  // Short episodes never qualify, even when their interior window is nonempty.
  if (runtimeMs <= 15 * 60 * 1000) return { startMs, endMs: startMs };
  const endMs = Math.max(
    startMs,
    Math.floor(
      (runtimeMs - Math.max(240000, config.endExclusionMs)) / SAMPLE_MS,
    ) * SAMPLE_MS,
  );
  return { startMs, endMs };
}

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

// Compare spatial brightness patterns independently of overall scene brightness.
export function spatialDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? Math.max(0, 1 - dot / Math.sqrt(aa * bb)) : 0;
}

function hasFade(video: VideoSample[], start: number, end: number): boolean {
  // Include the first black sample. Relative drop supports dark scenes;
  // three declining steps reject abrupt cuts, with little upward tolerance.
  // Measure the fade relative to the observed black level, not digital zero.
  const blackLevel = video
    .slice(start, end)
    .reduce((min, v) => Math.min(min, v.mean), 1);
  const samples = video
    .slice(Math.max(0, start - 15), start + 1)
    .map((v) => Math.max(0, v.mean - blackLevel));
  for (let i = 0; i < samples.length - 3; i++) {
    const tail = samples.slice(i);
    const first = tail[0]!;
    const last = tail.at(-1)!;
    const changes = tail.slice(1).map((v, j) => v - tail[j]!);
    if (
      first >= 0.04 &&
      last <= first * 0.2 &&
      changes.filter((v) => v < -first * 0.04).length >= 3 &&
      changes.every((v) => v <= first * 0.03)
    )
      return true;
  }
  return false;
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
  const offsetMs = features.startMs ?? 0;
  const window = breakScanWindow(runtimeMs, config);
  if (window.endMs <= window.startMs) return [];
  const absolute = (v: Interval): Interval => ({
    startMs: v.startMs + offsetMs,
    endMs: v.endMs + offsetMs,
  });
  const black = intervals(video.map((v) => v.blackRatio >= config.blackRatio))
    .map(absolute)
    .filter((v) => v.startMs >= window.startMs && v.endMs <= window.endMs);
  const silence = intervals(audioDb.map((v) => v <= config.silenceDb))
    .map(absolute)
    .filter((v) => v.endMs - v.startMs >= config.minSilenceMs);
  const guards = exclusions;
  let silenceIndex = 0;
  const candidates = black.map((event): BreakCandidate => {
    const start = Math.round((event.startMs - offsetMs) / SAMPLE_MS);
    const end = Math.round((event.endMs - offsetMs) / SAMPLE_MS);
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
    const spatialChange = Math.min(
      ...[20, 40, 60].map((offset) => {
        const a = video[start - offset];
        const b = video[end + offset];
        return a && b ? spatialDifference(a.pixels, b.pixels) : 0;
      }),
    );
    const fade = hasFade(video, start, end);
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
    // Long transitions need stronger evidence than black plus quiet audio.
    if (duration > 2000) {
      if (silenceOverlapMs < 1000)
        reasons.push('insufficient-extended-silence');
      if (spatialChange < config.spatialDifference)
        reasons.push('extended-scene-continuity');
    }
    if (!completeContext) reasons.push('incomplete-context');
    if (!audioContext) reasons.push('silent-surroundings');
    if (
      visualDifference < config.visualDifference &&
      spatialChange < config.spatialDifference
    )
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
        spatialDifference: spatialChange,
        motionBefore,
        motionAfter,
        audioContext,
        completeContext,
      },
    };
  });
  // A repeated animated bumper is independent evidence for a return to the
  // same scene. Never infer a boundary from recurrence or placement alone.
  const signatures = candidates.map((c) => {
    const start = Math.round((c.evidence.blackStartMs - offsetMs) / SAMPLE_MS);
    const samples = [50, 45, 40, 35, 30, 25, 20, 15, 10].map(
      (n) => video[start - n],
    );
    if (samples.some((v) => !v)) return undefined;
    const frames = samples.map((v) => v!.pixels);
    const texture = average(
      samples.map((v) => {
        const mean = average(Array.from(v!.pixels));
        return average(Array.from(v!.pixels, (p) => Math.abs(p - mean))) / 255;
      }),
    );
    const motion = average(
      frames.slice(1).map((v, i) => pixelDifference(v, frames[i]!)),
    );
    const duration = c.evidence.blackEndMs - c.evidence.blackStartMs;
    return c.evidence.fade &&
      c.evidence.completeContext &&
      c.evidence.silenceOverlapMs >= 800 &&
      duration >= 500 &&
      duration <= config.maxBlackMs &&
      !c.reasons.includes('excluded-region') &&
      texture >= 0.02 &&
      motion >= 0.008
      ? frames
      : undefined;
  });
  const contextReasons = new Set([
    'silent-surroundings',
    'scene-continuity',
    'static-context',
    'dark-context',
    'extended-scene-continuity',
  ]);
  // Bound pairwise work on unusually repetitive or corrupt inputs.
  const eligible = signatures.flatMap((s, i) => (s ? [i] : []));
  for (const i of eligible.length <= 256 ? eligible : []) {
    const signature = signatures[i];
    if (!signature) continue;
    const peers: number[] = [];
    for (const j of eligible) {
      const other = signatures[j];
      if (
        !other ||
        i === j ||
        Math.abs(candidates[i]!.timestampMs - candidates[j]!.timestampMs) <
          Math.max(180000, config.minimumSpacingMs)
      )
        continue;
      if (
        peers.some(
          (k) =>
            Math.abs(candidates[k]!.timestampMs - candidates[j]!.timestampMs) <
            Math.max(180000, config.minimumSpacingMs),
        )
      )
        continue;
      // Every frame must match, not just a logo or a shared black background.
      if (
        signature.every(
          (v, n) =>
            pixelDifference(v, other[n]!) <= config.bumperVisualDifference,
        )
      )
        peers.push(j);
    }
    candidates[i]!.evidence.repeatedBumperMatches = peers.length;
    if (peers.length < 2) continue;
    const candidate = candidates[i]!;
    candidate.reasons = candidate.reasons.filter((r) => !contextReasons.has(r));
    candidate.accepted = candidate.reasons.length === 0;
    if (candidate.accepted) candidate.confidence = 'high';
  }
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
