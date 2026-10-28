import type { MusicVideoMetadata } from './musicVideoMetadata.ts';

export type LabelWindow = [startSec: number, endSec: number];

export type LabelSpec = {
  lines: string[];
  windows: LabelWindow[];
};

export type LabelRender = LabelSpec & { fontFile: string };

type LabelTiming = {
  streamStartSec: number;
  videoDurationSec: number;
};

const StartWindow: LabelWindow = [5, 13];
const EndWindowLengthSec = 20;
const SkipTag = 'label:builtin';

function labelLines(meta: MusicVideoMetadata) {
  return [
    meta.artist,
    `"${meta.title}"`,
    meta.album,
    meta.label,
    meta.director,
  ].filter((line): line is string => !!line);
}

function videoWindows(durationSec: number): LabelWindow[] {
  const [start, end] = StartWindow;
  const startWindow: LabelWindow = [start, Math.min(end, durationSec)];
  const endWindowStart = durationSec - EndWindowLengthSec;
  if (endWindowStart < end) {
    return [startWindow];
  }
  return [startWindow, [endWindowStart, durationSec]];
}

function toStreamTime(
  windows: LabelWindow[],
  streamStartSec: number,
): LabelWindow[] {
  return windows
    .map(
      ([start, end]): LabelWindow => [
        Math.max(0, start - streamStartSec),
        end - streamStartSec,
      ],
    )
    .filter(([start, end]) => end > 0 && end > start);
}

export function buildLabelSpec(
  meta: MusicVideoMetadata | null,
  { streamStartSec, videoDurationSec }: LabelTiming,
): LabelSpec | null {
  if (!meta?.artist || meta.tags.includes(SkipTag)) {
    return null;
  }
  const windows = toStreamTime(videoWindows(videoDurationSec), streamStartSec);
  return windows.length > 0 ? { lines: labelLines(meta), windows } : null;
}
