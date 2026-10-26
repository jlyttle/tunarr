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
    test.each([
      ['interlaced', true, true],
      ['interlaced', false, false],
      ['progressive', true, false],
      ['unknown', true, false],
    ] as const)(
      'scan type %s with deinterlace enabled=%s produces deinterlace=%s',
      (scanType, enabled, expected) => {
        const details = makeStreamDetails();
        details.videoDetails![0]!.scanType = scanType;
        const calculator = new FfmpegPlaybackParamsCalculator(
          makeTranscodeConfig({ deinterlaceVideo: enabled }),
          'hls',
        );
        expect(calculator.calculateForStream(details).deinterlace).toBe(
          expected,
        );
      },
    );

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

    test('does not scale a video stream whose stored size is 0x0', () => {
      const [video] = makeStreamDetails().videoDetails ?? [];
      if (!video) {
        throw new Error('makeStreamDetails returned no video stream');
      }

      // Cover-art tracks scanned before attached pictures were skipped are
      // stored this way.
      const calculator = new FfmpegPlaybackParamsCalculator(
        makeTranscodeConfig(),
        'hls',
      );
      const params = calculator.calculateForStream({
        duration: dayjs.duration({ seconds: 30 }),
        videoDetails: [
          {
            ...video,
            codec: 'mjpeg',
            width: 0,
            height: 0,
            framerate: 90000,
            sampleAspectRatio: '1:1',
            displayAspectRatio: '1:1',
          },
        ],
      });

      expect(params.scaledSize).toBeUndefined();
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

describe('480i output', () => {
  const interlacedConfig = (
    aspectRatioMode: TranscodeConfigOrm['aspectRatioMode'],
  ) =>
    makeTranscodeConfig({
      interlacedOutput: true,
      aspectRatioMode,
      resolution: { widthPx: 720, heightPx: 480 },
      videoFormat: 'mpeg2video',
    });

  const calculate = (
    config: TranscodeConfigOrm,
    overrides: Partial<VideoStreamDetails> = {},
  ) => {
    const details = makeStreamDetails();
    Object.assign(details.videoDetails![0], overrides);
    return new FfmpegPlaybackParamsCalculator(config, 'hls').calculateForStream(
      details,
    );
  };

  test('480i params never deinterlace and run at 30000/1001', () => {
    const params = calculate(
      { ...interlacedConfig('crop'), deinterlaceVideo: true },
      { scanType: 'interlaced' },
    );

    expect(params.deinterlace).toBe(false);
    expect(params.frameRate).toBe(30000 / 1001);
    expect(params.videoPreset).toBeUndefined();
    expect(params.interlaced).toEqual({ path: 'fieldRate' });
  });

  test('480i 16:9 HD preserve scales to 720x360 and pads to 720x480', () => {
    const params = calculate(interlacedConfig('preserve'));

    expect(params.scaledSize).toMatchObject({ width: 720, height: 360 });
    expect(params.paddedSize).toMatchObject({ width: 720, height: 480 });
    expect(params.croppedSize).toBeUndefined();
  });

  test('480i 16:9 HD crop scales to 962x480 and crops to 720x480', () => {
    const params = calculate(interlacedConfig('crop'));

    expect(params.scaledSize).toMatchObject({ width: 962, height: 480 });
    expect(params.paddedSize).toMatchObject({ width: 720, height: 480 });
    expect(params.croppedSize).toMatchObject({ width: 720, height: 480 });
  });

  test('480i 4:3 DVD keeps 720x480 with no crop', () => {
    const params = calculate(interlacedConfig('crop'), {
      codec: 'mpeg2video',
      width: 720,
      height: 480,
      framerate: '29.97',
      scanType: 'interlaced',
      sampleAspectRatio: '8:9',
      displayAspectRatio: '4:3',
      anamorphic: true,
    });

    expect(params.interlaced).toEqual({ path: 'fields' });
    expect(params.scaledSize).toMatchObject({ width: 720, height: 480 });
    expect(params.paddedSize).toMatchObject({ width: 720, height: 480 });
    expect(params.croppedSize).toBeUndefined();
  });

  test('480i with a stored size of 0x0 sizes the field-rate path against a square 4:3 target', () => {
    const params = calculate(interlacedConfig('preserve'), {
      width: 0,
      height: 0,
    });

    expect(params.interlaced).toEqual({ path: 'fieldRate' });
    expect(params.scaledSize).toMatchObject({ width: 720, height: 360 });
    expect(params.paddedSize).toMatchObject({ width: 720, height: 480 });
    expect(params.croppedSize).toBeUndefined();
  });

  test('480i with a stored size of 0x0 and no aspect ratio fills 720x480', () => {
    const params = calculate(interlacedConfig('preserve'), {
      width: 0,
      height: 0,
      sampleAspectRatio: undefined,
      displayAspectRatio: '',
    });

    expect(params.scaledSize).toMatchObject({ width: 720, height: 480 });
    expect(params.paddedSize).toMatchObject({ width: 720, height: 480 });
  });
});
