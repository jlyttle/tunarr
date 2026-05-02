import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import { calculateAspectTransform } from '@/ffmpeg/FfmpegPlaybackParamsCalculator.js';
import type { VideoStreamDetails } from '@/stream/types.js';

const baseConfig = (
  overrides: Partial<
    Pick<TranscodeConfigOrm, 'aspectRatioMode' | 'resolution'>
  > = {},
) =>
  ({
    aspectRatioMode: 'preserve',
    resolution: {
      widthPx: 800,
      heightPx: 600,
    },
    ...overrides,
  }) satisfies Pick<TranscodeConfigOrm, 'aspectRatioMode' | 'resolution'>;

const baseVideoStream = (
  overrides: Partial<VideoStreamDetails> = {},
): VideoStreamDetails => ({
  codec: 'h264',
  profile: 'main',
  width: 1920,
  height: 1080,
  framerate: 24,
  scanType: 'progressive',
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  streamIndex: 0,
  sampleAspectRatio: '1:1',
  displayAspectRatio: '16:9',
  anamorphic: false,
  bitrate: 8_000_000,
  isAttachedPic: false,
  colorRange: null,
  colorSpace: null,
  colorTransfer: null,
  colorPrimaries: null,
  ...overrides,
});

describe('calculateAspectTransform', () => {
  test.each([
    [
      'preserve',
      'preserve',
      { width: 800, height: 450 },
      { width: 800, height: 600 },
      undefined,
    ],
    [
      'crop',
      'crop',
      { width: 1068, height: 600 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    ],
    [
      'stretch',
      'stretch',
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      undefined,
    ],
  ])(
    'transforms 16:9 source to 4:3 target in %s mode',
    (aspectRatioMode, resizeMode, scaledSize, paddedSize, croppedSize) => {
      const transform = calculateAspectTransform(
        baseConfig({ aspectRatioMode }),
        baseVideoStream(),
      );

      expect(transform.resizeMode).toBe(resizeMode);
      expect(transform.scaledSize).toMatchObject(scaledSize);
      expect(transform.paddedSize).toMatchObject(paddedSize);
      if (croppedSize) {
        expect(transform.croppedSize).toMatchObject(croppedSize);
      } else {
        expect(transform.croppedSize).toBeUndefined();
      }
    },
  );

  test.each([
    [
      'preserve',
      'preserve',
      { width: 1440, height: 1080 },
      { width: 1920, height: 1080 },
      undefined,
    ],
    [
      'crop',
      'crop',
      { width: 1920, height: 1440 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    ],
    [
      'stretch',
      'stretch',
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
      undefined,
    ],
  ])(
    'transforms 4:3 source to 16:9 target in %s mode',
    (aspectRatioMode, resizeMode, scaledSize, paddedSize, croppedSize) => {
      const transform = calculateAspectTransform(
        baseConfig({
          aspectRatioMode,
          resolution: { widthPx: 1920, heightPx: 1080 },
        }),
        baseVideoStream({
          width: 640,
          height: 480,
          displayAspectRatio: '4:3',
        }),
      );

      expect(transform.resizeMode).toBe(resizeMode);
      expect(transform.scaledSize).toMatchObject(scaledSize);
      expect(transform.paddedSize).toMatchObject(paddedSize);
      if (croppedSize) {
        expect(transform.croppedSize).toMatchObject(croppedSize);
      } else {
        expect(transform.croppedSize).toBeUndefined();
      }
    },
  );

  test.each(['preserve', 'crop', 'stretch'] as const)(
    'does not crop or stretch matching aspect content in %s mode',
    (aspectRatioMode) => {
      const transform = calculateAspectTransform(
        baseConfig({ aspectRatioMode }),
        baseVideoStream({
          width: 640,
          height: 480,
          displayAspectRatio: '4:3',
        }),
      );

      expect(transform.scaledSize).toMatchObject({ width: 800, height: 600 });
      expect(transform.paddedSize).toMatchObject({ width: 800, height: 600 });
      expect(transform.croppedSize).toBeUndefined();
    },
  );

  test('uses anamorphic display aspect ratio when computing transform', () => {
    const transform = calculateAspectTransform(
      baseConfig({
        aspectRatioMode: 'preserve',
        resolution: { widthPx: 1920, heightPx: 1080 },
      }),
      baseVideoStream({
        width: 720,
        height: 480,
        sampleAspectRatio: '8:9',
        displayAspectRatio: '4:3',
        anamorphic: true,
      }),
    );

    expect(transform.scaledSize).toMatchObject({ width: 1440, height: 1080 });
    expect(transform.paddedSize).toMatchObject({ width: 1920, height: 1080 });
    expect(transform.croppedSize).toBeUndefined();
  });
});
