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

function singleLine(value: string | undefined) {
  return (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

function labelLines(meta: MusicVideoMetadata) {
  const title = singleLine(meta.title);
  return [
    singleLine(meta.artist),
    title && `"${title}"`,
    singleLine(meta.album),
    singleLine(meta.label),
    singleLine(meta.director),
  ].filter((line) => line.length > 0);
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
  if (!meta || !singleLine(meta.artist) || meta.tags.includes(SkipTag)) {
    return null;
  }
  const windows = toStreamTime(videoWindows(videoDurationSec), streamStartSec);
  return windows.length > 0 ? { lines: labelLines(meta), windows } : null;
}
