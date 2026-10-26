import type {
  AspectRatioMode,
  TranscodeConfigOrm,
} from '@/db/schema/TranscodeConfig.js';
import type { VideoStreamDetails } from '@/stream/types.js';
import type { Maybe } from '@/types/util.js';
import { isEqual } from 'lodash-es';
import { VideoFormats } from '../builder/constants.ts';
import { FrameSize } from '../builder/types.ts';
import { calculateDisplayAspectRatio } from '../FfmpegPlaybackParamsCalculator.ts';

export const Interlaced480Size = FrameSize.withDimensions(720, 480);

export const Interlaced480FrameRate = 30000 / 1001;

export type Interlaced480Plan =
  | { path: 'fields'; cropWidth?: number }
  | { path: 'fieldRate' };

const FieldHeights = [480, 486];
const FieldWidths = [720, 704];
const FieldRateTolerance = 0.05;
const WidescreenAspectRatio = 1.5;

const Interlaced480Config = {
  resolution: { widthPx: 720, heightPx: 480 },
  videoFormat: 'mpeg2video',
  hardwareAccelerationMode: 'none',
  deinterlaceVideo: false,
  normalizeFrameRate: true,
} satisfies Partial<TranscodeConfigOrm>;

export function parseFrameRate(
  rate: Maybe<number | string>,
): number | undefined {
  const parsed = typeof rate === 'string' ? parseRateString(rate) : rate;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function parseRateString(rate: string) {
  const [num, den] = rate.split('/');
  return den === undefined ? Number(num) : Number(num) / Number(den);
}

export function interlaced480Plan(
  stream: VideoStreamDetails,
  mode: AspectRatioMode,
): Interlaced480Plan {
  const isWidescreen =
    calculateDisplayAspectRatio(stream) >= WidescreenAspectRatio;

  if (!hasFields(stream) || (mode === 'preserve' && isWidescreen)) {
    return { path: 'fieldRate' };
  }

  if (mode === 'crop' && isWidescreen) {
    return { path: 'fields', cropWidth: cropWidthFor(stream) };
  }

  return { path: 'fields' };
}

function hasFields(stream: VideoStreamDetails) {
  return (
    FieldHeights.includes(stream.height) &&
    FieldWidths.includes(stream.width) &&
    hasFieldFrameRate(stream)
  );
}

function hasFieldFrameRate(stream: VideoStreamDetails) {
  if (stream.codec === VideoFormats.Mpeg2Video) {
    return true;
  }

  const rate = parseFrameRate(stream.framerate);
  return (
    rate === undefined ||
    Math.abs(rate - Interlaced480FrameRate) <= FieldRateTolerance
  );
}

function cropWidthFor(stream: VideoStreamDetails) {
  return evenRound(
    (Interlaced480Size.width * (4 / 3)) / calculateDisplayAspectRatio(stream),
  );
}

function evenRound(value: number) {
  return Math.round(value / 2) * 2;
}

export function enforceInterlaced480(config: TranscodeConfigOrm): {
  config: TranscodeConfigOrm;
  overridden: string[];
} {
  if (!config.interlacedOutput) {
    return { config, overridden: [] };
  }

  const overridden = Object.entries(Interlaced480Config)
    .filter(
      ([key, value]) =>
        !isEqual(config[key as keyof typeof Interlaced480Config], value),
    )
    .map(([key]) => key);

  return { config: { ...config, ...Interlaced480Config }, overridden };
}
