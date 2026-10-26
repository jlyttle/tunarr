import { describe, expect, test } from 'vitest';
import {
  Interlaced480Defaults,
  interlaced480Warnings,
} from './interlaced480.ts';

const on = {
  interlacedOutput: true,
  ...Interlaced480Defaults,
  aspectRatioMode: 'crop',
} as const;

describe('interlaced480Warnings', () => {
  test('off gives no warnings', () => {
    expect(
      interlaced480Warnings({
        ...on,
        interlacedOutput: false,
        videoFormat: 'h264',
        aspectRatioMode: 'preserve',
      }),
    ).toEqual([]);
  });

  test('defaults give no warnings except preserve', () => {
    expect(interlaced480Warnings(on)).toEqual([]);
    expect(
      interlaced480Warnings({ ...on, aspectRatioMode: 'preserve' }),
    ).toEqual(['preserveWidescreen']);
  });

  test('each incompatible value warns', () => {
    expect(
      interlaced480Warnings({
        ...on,
        resolution: { widthPx: 1920, heightPx: 1080 },
      }),
    ).toEqual(['resolution']);
    expect(interlaced480Warnings({ ...on, videoFormat: 'h264' })).toEqual([
      'videoFormat',
    ]);
    expect(
      interlaced480Warnings({ ...on, hardwareAccelerationMode: 'vaapi' }),
    ).toEqual(['hardwareAcceleration']);
    expect(interlaced480Warnings({ ...on, normalizeFrameRate: false })).toEqual(
      ['frameRate'],
    );
    expect(interlaced480Warnings({ ...on, deinterlaceVideo: true })).toEqual([
      'deinterlace',
    ]);
  });
});
