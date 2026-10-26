import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import type { VideoStreamDetails } from '@/stream/types.js';
import {
  enforceInterlaced480,
  interlaced480Plan,
  parseFrameRate,
} from './Interlaced480.ts';

function makeVideoStream(
  overrides: Partial<VideoStreamDetails> = {},
): VideoStreamDetails {
  return {
    codec: 'mpeg2video',
    profile: 'main',
    width: 720,
    height: 480,
    framerate: '29.97',
    scanType: 'interlaced',
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    streamIndex: 0,
    sampleAspectRatio: '8:9',
    displayAspectRatio: '4:3',
    anamorphic: true,
    bitrate: 6_000_000,
    isAttachedPic: false,
    colorRange: null,
    colorSpace: null,
    colorTransfer: null,
    colorPrimaries: null,
    ...overrides,
  };
}

function makeHdStream(
  overrides: Partial<VideoStreamDetails> = {},
): VideoStreamDetails {
  return makeVideoStream({
    codec: 'h264',
    width: 1920,
    height: 1080,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    anamorphic: false,
    ...overrides,
  });
}

function makeTranscodeConfig(
  overrides: Partial<TranscodeConfigOrm> = {},
): TranscodeConfigOrm {
  return {
    uuid: 'test-uuid',
    name: 'Test',
    hardwareAccelerationMode: 'vaapi',
    resolution: { widthPx: 1920, heightPx: 1080 },
    videoFormat: 'h264',
    deinterlaceVideo: true,
    normalizeFrameRate: false,
    interlacedOutput: true,
    ...overrides,
  } as TranscodeConfigOrm;
}

describe('Interlaced480', () => {
  test('parses decimal and rational rates', () => {
    expect(parseFrameRate('29.97')).toBe(29.97);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 3);
    expect(parseFrameRate('23.98')).toBe(23.98);
    expect(parseFrameRate(undefined)).toBeUndefined();
    expect(parseFrameRate('abc')).toBeUndefined();
  });

  test('a 4:3 interlaced DVD takes the fields path', () => {
    expect(interlaced480Plan(makeVideoStream(), 'crop')).toEqual({
      path: 'fields',
    });
  });

  test('unknown frame rate at 720x480 takes the fields path', () => {
    const stream = makeVideoStream({
      codec: 'h264',
      framerate: undefined,
      scanType: 'unknown',
    });

    expect(interlaced480Plan(stream, 'crop')).toEqual({ path: 'fields' });
  });

  test('a 23.976 h264 480p takes the field-rate path', () => {
    const stream = makeVideoStream({
      codec: 'h264',
      framerate: '23.98',
      scanType: 'progressive',
    });

    expect(interlaced480Plan(stream, 'crop')).toEqual({ path: 'fieldRate' });
  });

  test('16:9 anamorphic SD in crop crops 540 wide', () => {
    const stream = makeVideoStream({
      sampleAspectRatio: '32:27',
      displayAspectRatio: '16:9',
    });

    expect(interlaced480Plan(stream, 'crop')).toEqual({
      path: 'fields',
      cropWidth: 540,
    });
  });

  test('16:9 anamorphic SD in preserve takes the field-rate path', () => {
    const stream = makeVideoStream({
      sampleAspectRatio: '32:27',
      displayAspectRatio: '16:9',
    });

    expect(interlaced480Plan(stream, 'preserve')).toEqual({
      path: 'fieldRate',
    });
  });

  test('1080i and 1080p take the field-rate path', () => {
    const interlaced = makeHdStream({ scanType: 'interlaced' });
    const progressive = makeHdStream({
      scanType: 'progressive',
      framerate: 23.976,
    });

    expect(interlaced480Plan(interlaced, 'crop')).toEqual({
      path: 'fieldRate',
    });
    expect(interlaced480Plan(progressive, 'crop')).toEqual({
      path: 'fieldRate',
    });
  });

  test('640x480 takes the field-rate path', () => {
    const stream = makeVideoStream({
      codec: 'h264',
      width: 640,
      sampleAspectRatio: '1:1',
    });

    expect(interlaced480Plan(stream, 'crop')).toEqual({ path: 'fieldRate' });
  });

  test('enforce lists only the changed keys', () => {
    const changed = enforceInterlaced480(makeTranscodeConfig());
    const alreadySet = enforceInterlaced480(
      makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        resolution: { widthPx: 720, heightPx: 480 },
        videoFormat: 'mpeg2video',
        deinterlaceVideo: false,
        normalizeFrameRate: true,
      }),
    );

    expect(changed.overridden).toEqual([
      'resolution',
      'videoFormat',
      'hardwareAccelerationMode',
      'deinterlaceVideo',
      'normalizeFrameRate',
    ]);
    expect(changed.config).toMatchObject({
      resolution: { widthPx: 720, heightPx: 480 },
      videoFormat: 'mpeg2video',
      hardwareAccelerationMode: 'none',
      deinterlaceVideo: false,
      normalizeFrameRate: true,
    });
    expect(alreadySet.overridden).toEqual([]);
  });

  test('enforce leaves a config with the option off untouched', () => {
    const config = makeTranscodeConfig({ interlacedOutput: false });

    const result = enforceInterlaced480(config);

    expect(result.config).toBe(config);
    expect(result.overridden).toEqual([]);
  });
});
