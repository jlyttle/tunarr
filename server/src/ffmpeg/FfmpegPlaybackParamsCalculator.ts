import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import {
  type AspectRatioMode,
  HardwareAccelerationMode,
  TranscodeAudioOutputFormat,
} from '@/db/schema/TranscodeConfig.js';
import type { ChannelStreamMode } from '@/db/schema/base.js';
import type { StreamDetails, VideoStreamDetails } from '@/stream/types.js';
import { ChannelStreamModes } from '@tunarr/types';
import { match, P } from 'ts-pattern';
import type { VideoPreset } from './builder/constants.ts';
import {
  VideoFormats,
  VideoPresets,
  type OutputFormat,
  type VideoFormat,
} from './builder/constants.ts';
import type { PixelFormat } from './builder/format/PixelFormat.ts';
import { PixelFormatYuv420P } from './builder/format/PixelFormat.ts';
import { FrameSize } from './builder/types.ts';
import type { Interlaced480Plan } from './interlaced/Interlaced480.ts';
import {
  interlaced480Plan,
  Interlaced480FrameRate,
  Interlaced480Size,
} from './interlaced/Interlaced480.ts';

export class FfmpegPlaybackParamsCalculator {
  constructor(
    private transcodeConfig: TranscodeConfigOrm,
    private streamMode: ChannelStreamMode,
  ) {}

  calculateForStream(streamDetails: StreamDetails): FfmpegPlaybackParams {
    if (
      this.streamMode === ChannelStreamModes.HlsDirect ||
      this.streamMode === ChannelStreamModes.HlsDirectV2
    ) {
      return {
        hwAccel: HardwareAccelerationMode.None,
        audioFormat: TranscodeAudioOutputFormat.Copy,
        videoFormat: 'copy', // Should be included in DB options
        deinterlace: false,
      } satisfies FfmpegPlaybackParams;
    }

    // TODO: Check channel mode;
    const params: FfmpegPlaybackParams = {
      audioFormat: this.transcodeConfig.audioFormat,
      audioBitrate: this.transcodeConfig.audioBitRate,
      audioBufferSize: this.transcodeConfig.audioBufferSize,
      audioChannels: this.transcodeConfig.audioChannels,
      audioSampleRate: this.transcodeConfig.audioSampleRate,
      hwAccel: this.transcodeConfig.hardwareAccelerationMode,
      videoFormat: this.transcodeConfig.videoFormat,
      videoBitrate: this.transcodeConfig.videoBitRate,
      videoBufferSize: this.transcodeConfig.videoBufferSize,
    };

    if (streamDetails.videoDetails) {
      const [videoStream] = streamDetails.videoDetails;
      // A stored size of 0x0 means the size is unknown, so there is no aspect
      // ratio to scale from.
      if (videoStream.width > 0 && videoStream.height > 0) {
        const aspectTransform = calculateAspectTransform(
          this.transcodeConfig,
          videoStream,
        );
        params.resizeMode = aspectTransform.resizeMode;
        params.scaledSize = aspectTransform.scaledSize;
        params.paddedSize = aspectTransform.paddedSize;
        params.croppedSize = aspectTransform.croppedSize;
      }

      params.videoPreset = match([
        this.transcodeConfig.hardwareAccelerationMode,
        this.transcodeConfig.videoFormat,
        videoStream.bitDepth,
      ])
        .with(
          ['none', P.union(VideoFormats.H264, VideoFormats.Hevc), P._],
          () => VideoPresets.VeryFast,
        )
        .otherwise(() => undefined);

      // We only have an option for maxFPS right now...
      // if (
      //   isNil(videoStream.framerate) ||
      //   round(videoStream.framerate, 3) > this.ffmpegOptions.maxFPS
      // ) {
      //   params.frameRate = this.ffmpegOptions.maxFPS;
      // }

      params.videoTrackTimeScale = 90000;

      // Filter for attached pic???
      // match([params.hwAccel, videoStream.codec, videoStream.pixelFormat])
      //   .with([HardwareAccelerationMode.Cuda, VideoFormats.H264, P.union(PixelFormats.YUV420P10LE, PixelFormats.YUV444P, PixelFormats.YUV444P10LE)], () => 'h264')
      //   .with([HardwareAccelerationMode.Cuda, VideoFormats.Hevc, P.union(PixelFormats.YUV420P10LE, PixelFormats.YUV444P, PixelFormats.YUV444P10LE)], () => 'h264')
      // TODO ffmpeg options for bit depth!
      params.pixelFormat = new PixelFormatYuv420P();

      params.deinterlace =
        !!this.transcodeConfig.deinterlaceVideo &&
        videoStream.scanType === 'interlaced';

      if (this.transcodeConfig.interlacedOutput) {
        Object.assign(
          params,
          calculateInterlaced480Params(this.transcodeConfig, videoStream),
        );
      }
    }

    return params;
  }

  calculateForErrorStream(
    outputFormat: OutputFormat,
    hlsRealtime: boolean,
  ): FfmpegPlaybackParams {
    return {
      audioFormat: this.transcodeConfig.audioFormat,
      audioBitrate: this.transcodeConfig.audioBitRate,
      audioBufferSize: this.transcodeConfig.audioBufferSize,
      audioChannels: this.transcodeConfig.audioChannels,
      audioSampleRate: this.transcodeConfig.audioSampleRate,
      hwAccel: this.transcodeConfig.hardwareAccelerationMode,
      videoFormat: this.transcodeConfig.videoFormat,
      videoBitrate: this.transcodeConfig.videoBitRate,
      videoBufferSize: this.transcodeConfig.videoBufferSize,
      videoTrackTimeScale: 90_000,
      frameRate: 24,
      realtime: outputFormat.type === 'hls' ? hlsRealtime : true,
    };
  }

  calculateForHlsConcat(): FfmpegPlaybackParams {
    return {
      audioFormat: this.transcodeConfig.audioFormat,
      audioBitrate: this.transcodeConfig.audioBitRate,
      audioBufferSize: this.transcodeConfig.audioBufferSize,
      audioChannels: this.transcodeConfig.audioChannels,
      audioSampleRate: this.transcodeConfig.audioSampleRate,
      hwAccel: this.transcodeConfig.hardwareAccelerationMode,
      videoFormat: this.transcodeConfig.videoFormat,
      videoBitrate: this.transcodeConfig.videoBitRate,
      videoBufferSize: this.transcodeConfig.videoBufferSize,
      videoTrackTimeScale: 90_000,
      frameRate: 24,
      realtime: false,
    };
  }
}

export type FfmpegPlaybackParams = {
  hwAccel: HardwareAccelerationMode;
  frameRate?: number;
  resizeMode?: AspectRatioMode;
  scaledSize?: FrameSize;
  paddedSize?: FrameSize;
  croppedSize?: FrameSize;
  videoTrackTimeScale?: number;
  realtime?: boolean;

  // video details
  videoFormat: VideoFormat;
  videoBitrate?: number;
  videoBufferSize?: number;
  videoProfile?: string;
  videoPreset?: VideoPreset;
  pixelFormat?: PixelFormat;
  deinterlace?: boolean;
  interlaced?: Interlaced480Plan;

  // audio details
  audioFormat: TranscodeAudioOutputFormat;
  audioBitrate?: number;
  audioBufferSize?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  audioDuration?: number;
};

const AspectRatioTolerance = 0.01;

const SquarePixel480Resolution = { widthPx: 640, heightPx: 480 };

const UnknownSizeStream = {
  width: 640,
  height: 480,
  sampleAspectRatio: undefined,
};

export type AspectTransform = {
  resizeMode: AspectRatioMode;
  scaledSize: FrameSize;
  paddedSize: FrameSize;
  croppedSize?: FrameSize;
};

export function calculateAspectTransform(
  config: Pick<TranscodeConfigOrm, 'aspectRatioMode' | 'resolution'>,
  videoStream: VideoStreamDetails,
): AspectTransform {
  const targetSize = FrameSize.fromResolution(config.resolution).ensureEven();
  const targetAspectRatio = targetSize.width / targetSize.height;
  const sourceAspectRatio = calculateDisplayAspectRatio(videoStream);
  const aspectRatioMode = config.aspectRatioMode ?? 'preserve';
  const aspectRatioMatches =
    Math.abs(sourceAspectRatio - targetAspectRatio) <= AspectRatioTolerance;

  if (aspectRatioMode === 'stretch') {
    return {
      resizeMode: aspectRatioMode,
      scaledSize: targetSize,
      paddedSize: targetSize,
    };
  }

  if (aspectRatioMatches) {
    return {
      resizeMode: aspectRatioMode,
      scaledSize: targetSize,
      paddedSize: targetSize,
    };
  }

  if (aspectRatioMode === 'crop') {
    return {
      resizeMode: aspectRatioMode,
      scaledSize: calculateFillSize(sourceAspectRatio, targetSize),
      paddedSize: targetSize,
      croppedSize: targetSize,
    };
  }

  return {
    resizeMode: 'preserve',
    scaledSize: calculateFitSize(sourceAspectRatio, targetSize),
    paddedSize: targetSize,
  };
}

export function calculateInterlaced480Transform(
  mode: AspectRatioMode,
  videoStream: VideoStreamDetails,
): AspectTransform {
  const squarePixelTransform = calculateAspectTransform(
    { aspectRatioMode: mode, resolution: SquarePixel480Resolution },
    videoStream,
  );

  return {
    resizeMode: squarePixelTransform.resizeMode,
    scaledSize: toInterlaced480Pixels(squarePixelTransform.scaledSize),
    paddedSize: toInterlaced480Pixels(squarePixelTransform.paddedSize),
    croppedSize:
      squarePixelTransform.croppedSize &&
      toInterlaced480Pixels(squarePixelTransform.croppedSize),
  };
}

function calculateInterlaced480Params(
  config: Pick<TranscodeConfigOrm, 'aspectRatioMode'>,
  videoStream: VideoStreamDetails,
): Partial<FfmpegPlaybackParams> {
  const params = {
    deinterlace: false,
    frameRate: Interlaced480FrameRate,
    videoPreset: undefined,
  };

  const mode = config.aspectRatioMode ?? 'preserve';

  if (videoStream.width <= 0 || videoStream.height <= 0) {
    return {
      ...params,
      interlaced: { path: 'fieldRate' },
      ...calculateInterlaced480Transform(mode, {
        ...videoStream,
        ...UnknownSizeStream,
      }),
    };
  }

  const interlaced = interlaced480Plan(videoStream, mode);
  const transform: AspectTransform =
    interlaced.path === 'fields'
      ? {
          resizeMode: mode,
          scaledSize: Interlaced480Size,
          paddedSize: Interlaced480Size,
          croppedSize: undefined,
        }
      : calculateInterlaced480Transform(mode, videoStream);

  return { ...params, interlaced, ...transform };
}

function toInterlaced480Pixels(size: FrameSize) {
  return FrameSize.create({
    width: ceilEven((size.width * 9) / 8),
    height: size.height,
  });
}

function calculateFillSize(sourceAspectRatio: number, targetSize: FrameSize) {
  const targetAspectRatio = targetSize.width / targetSize.height;

  if (sourceAspectRatio >= targetAspectRatio) {
    return FrameSize.create({
      width: ceilEven(targetSize.height * sourceAspectRatio),
      height: targetSize.height,
    });
  }

  return FrameSize.create({
    width: targetSize.width,
    height: ceilEven(targetSize.width / sourceAspectRatio),
  });
}

function calculateFitSize(sourceAspectRatio: number, targetSize: FrameSize) {
  const targetAspectRatio = targetSize.width / targetSize.height;

  if (sourceAspectRatio >= targetAspectRatio) {
    return FrameSize.create({
      width: targetSize.width,
      height: floorEven(targetSize.width / sourceAspectRatio),
    });
  }

  return FrameSize.create({
    width: floorEven(targetSize.height * sourceAspectRatio),
    height: targetSize.height,
  });
}

export function calculateDisplayAspectRatio(videoStream: VideoStreamDetails) {
  const numericSar = parseAspectRatio(videoStream.sampleAspectRatio);
  if (numericSar && numericSar.den !== 0) {
    return (
      (videoStream.width * numericSar.num) /
      (videoStream.height * numericSar.den)
    );
  }

  const numericDar = parseAspectRatio(videoStream.displayAspectRatio);
  if (numericDar && numericDar.den !== 0) {
    return numericDar.num / numericDar.den;
  }

  return videoStream.width / videoStream.height;
}

function parseAspectRatio(value?: string) {
  if (!value) {
    return null;
  }

  const [numS, denS] = value.split(':');
  if (!numS || !denS) {
    return null;
  }

  const num = parseFloat(numS);
  const den = parseFloat(denS);
  if (isNaN(num) || isNaN(den) || num <= 0 || den <= 0) {
    return null;
  }

  return { num, den };
}

function floorEven(value: number) {
  return Math.max(2, Math.floor(value) - (Math.floor(value) % 2));
}

function ceilEven(value: number) {
  const ceil = Math.ceil(value);
  return ceil % 2 === 0 ? ceil : ceil + 1;
}
