import type { TranscodeConfig } from '@tunarr/types';

export const Interlaced480Defaults = {
  resolution: { widthPx: 720, heightPx: 480 },
  videoFormat: 'mpeg2video',
  hardwareAccelerationMode: 'none',
  normalizeFrameRate: true,
  deinterlaceVideo: false,
} as const;

export type Interlaced480Warning =
  | 'resolution'
  | 'videoFormat'
  | 'hardwareAcceleration'
  | 'frameRate'
  | 'deinterlace'
  | 'preserveWidescreen';

type Interlaced480Values = Pick<
  TranscodeConfig,
  | 'resolution'
  | 'videoFormat'
  | 'hardwareAccelerationMode'
  | 'normalizeFrameRate'
  | 'deinterlaceVideo'
> &
  Partial<Pick<TranscodeConfig, 'interlacedOutput' | 'aspectRatioMode'>>;

export function interlaced480Warnings(
  values: Interlaced480Values,
): Interlaced480Warning[] {
  if (!values.interlacedOutput) {
    return [];
  }

  const warnings: [boolean, Interlaced480Warning][] = [
    [
      values.resolution.widthPx !== Interlaced480Defaults.resolution.widthPx ||
        values.resolution.heightPx !==
          Interlaced480Defaults.resolution.heightPx,
      'resolution',
    ],
    [values.videoFormat !== Interlaced480Defaults.videoFormat, 'videoFormat'],
    [
      values.hardwareAccelerationMode !==
        Interlaced480Defaults.hardwareAccelerationMode,
      'hardwareAcceleration',
    ],
    [!values.normalizeFrameRate, 'frameRate'],
    [values.deinterlaceVideo, 'deinterlace'],
    [values.aspectRatioMode === 'preserve', 'preserveWidescreen'],
  ];

  return warnings.filter(([applies]) => applies).map(([, name]) => name);
}
