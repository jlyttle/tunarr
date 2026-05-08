import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import type { StreamDetails, VideoStreamDetails } from '@/stream/types.js';
import { VideoPresets } from './builder/constants.ts';
import {
  calculateAspectTransform,
  FfmpegPlaybackParamsCalculator,
} from './FfmpegPlaybackParamsCalculator.ts';

dayjs.extend(duration);

function makeTranscodeConfig(
  overrides: Partial<TranscodeConfigOrm> = {},
): TranscodeConfigOrm {
  return {
    uuid: 'test-uuid',
    name: 'Test',
    threadCount: 0,
    hardwareAccelerationMode: 'none',
    vaapiDriver: 'system',
    vaapiDevice: null,
    resolution: { widthPx: 1920, heightPx: 1080 },
    videoFormat: 'h264',
    videoProfile: null,
    videoPreset: null,
    videoBitDepth: 8,
    videoBitRate: 2000,
    videoBufferSize: 4000,
    aspectRatioMode: 'preserve',
    audioChannels: 2,
    audioFormat: 'aac',
    audioBitRate: 192,
    audioBufferSize: 384,
    audioSampleRate: 48,
    audioVolumePercent: 100,
    audioLoudnormConfig: null,
    normalizeFrameRate: false,
    deinterlaceVideo: true,
    disableChannelOverlay: false,
    errorScreen: 'pic',
    errorScreenAudio: 'silent',
    isDefault: true,
    disableHardwareDecoder: false,
    disableHardwareEncoding: false,
    disableHardwareFilters: false,
    ...overrides,
  } as TranscodeConfigOrm;
}

function makeStreamDetails(
  overrides: Partial<StreamDetails['videoDetails']> = {},
): StreamDetails {
  return {
    duration: dayjs.duration({ seconds: 30 }),
    videoDetails: [
      {
        codec: 'h264',
        profile: 'Main',
        width: 1920,
        height: 1080,
        framerate: 24,
        pixelFormat: 'yuv420p',
        bitDepth: 8,
        streamIndex: 0,
        sampleAspectRatio: '1:1',
        displayAspectRatio: '16:9',
        anamorphic: false,
        bitrate: 5000,
        isAttachedPic: false,
        colorRange: null,
        colorSpace: null,
        colorTransfer: null,
        colorPrimaries: null,
      },
    ],
  };
}

describe('FfmpegPlaybackParamsCalculator', () => {
  describe('calculateForStream', () => {
    test('sets videoPreset to veryfast for software h264 encoding', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('sets videoPreset to veryfast for software hevc encoding', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'hevc',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('does not set videoPreset for hardware-accelerated encoding', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'cuda',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBeUndefined();
    });

    test('does not set videoPreset for mpeg2video format', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'mpeg2video',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBeUndefined();
    });

    test('does not set videoPreset for HLS direct mode', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(
        config,
        'hls_direct',
      );
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBeUndefined();
    });

    test('does not set videoPreset for HLS direct v2 mode', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(
        config,
        'hls_direct_v2',
      );
      const params = calculator.calculateForStream(makeStreamDetails());

      expect(params.videoPreset).toBeUndefined();
    });

    test('does not clobber videoProfile with the preset value', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const params = calculator.calculateForStream(makeStreamDetails());

      // videoProfile should NOT contain a preset value
      expect(params.videoProfile).not.toBe(VideoPresets.VeryFast);
    });

    test('does not set videoPreset when there are no video details', () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });

      const calculator = new FfmpegPlaybackParamsCalculator(config, 'hls');
      const streamDetails: StreamDetails = {
        duration: dayjs.duration({ seconds: 30 }),
        // No videoDetails
      };

      const params = calculator.calculateForStream(streamDetails);

      expect(params.videoPreset).toBeUndefined();
    });
  });
});

const baseAspectConfig = (
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
  ] as const)(
    'transforms 16:9 source to 4:3 target in %s mode',
    (aspectRatioMode, resizeMode, scaledSize, paddedSize, croppedSize) => {
      const transform = calculateAspectTransform(
        baseAspectConfig({ aspectRatioMode }),
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
  ] as const)(
    'transforms 4:3 source to 16:9 target in %s mode',
    (aspectRatioMode, resizeMode, scaledSize, paddedSize, croppedSize) => {
      const transform = calculateAspectTransform(
        baseAspectConfig({
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
        baseAspectConfig({ aspectRatioMode }),
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
      baseAspectConfig({
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
