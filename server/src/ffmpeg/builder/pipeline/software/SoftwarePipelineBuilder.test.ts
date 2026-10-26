import { FileStreamSource } from '@/stream/types.js';
import type { Watermark } from '@tunarr/types';
import { EmptyFfmpegCapabilities } from '../../capabilities/FfmpegCapabilities.ts';
import type { Interlaced480Plan } from '../../../interlaced/Interlaced480.ts';
import { CropFilter } from '../../filter/CropFilter.ts';
import { DeinterlaceFilter } from '../../filter/DeinterlaceFilter.ts';
import { FieldRateFilter } from '../../filter/interlaced/FieldRateFilter.ts';
import { PadFilter } from '../../filter/PadFilter.ts';
import { ScaleFilter } from '../../filter/ScaleFilter.ts';
import { OverlayWatermarkFilter } from '../../filter/watermark/OverlayWatermarkFilter.ts';
import { PixelFormatYuv420P } from '../../format/PixelFormat.ts';
import { VideoInputSource } from '../../input/VideoInputSource.ts';
import { WatermarkInputSource } from '../../input/WatermarkInputSource.ts';
import { StillImageStream, VideoStream } from '../../MediaStream.ts';
import {
  DefaultPipelineOptions,
  FfmpegState,
} from '../../state/FfmpegState.ts';
import { FrameState } from '../../state/FrameState.ts';
import { FrameSize } from '../../types.ts';
import { SoftwarePipelineBuilder } from './SoftwarePipelineBuilder.ts';

function makeVideoInput() {
  return VideoInputSource.withStream(
    new FileStreamSource('/path/to/video.mkv'),
    VideoStream.create({
      codec: 'h264',
      profile: 'main',
      displayAspectRatio: '16:9',
      frameSize: FrameSize.FHD,
      index: 0,
      pixelFormat: new PixelFormatYuv420P(),
      providedSampleAspectRatio: '1:1',
      colorFormat: null,
    }),
  );
}

function makeWatermarkInput(watermark: Partial<Watermark> = {}) {
  return new WatermarkInputSource(
    new FileStreamSource('/path/to/watermark.png'),
    StillImageStream.create({
      frameSize: FrameSize.withDimensions(100, 100),
      index: 1,
    }),
    {
      duration: 0,
      enabled: true,
      horizontalMargin: 10,
      opacity: 100,
      position: 'bottom-right',
      verticalMargin: 10,
      width: 10,
      ...watermark,
    } satisfies Watermark,
  );
}

function makeSdVideoInput(frameSize: FrameSize, sampleAspectRatio = '8:9') {
  return VideoInputSource.withStream(
    new FileStreamSource('/path/to/video.mpg'),
    VideoStream.create({
      codec: 'mpeg2video',
      profile: 'main',
      displayAspectRatio: '4:3',
      frameSize,
      index: 0,
      pixelFormat: new PixelFormatYuv420P(),
      providedSampleAspectRatio: sampleAspectRatio,
      colorFormat: null,
    }),
  );
}

function buildPipeline(
  desiredState: FrameState,
  watermark?: WatermarkInputSource,
  video: VideoInputSource = makeVideoInput(),
) {
  const builder = new SoftwarePipelineBuilder(
    video,
    null,
    watermark ?? null,
    null,
    null,
    EmptyFfmpegCapabilities,
  );

  return builder.build(
    FfmpegState.create({
      version: { versionString: '7.1.1', isUnknown: false },
    }),
    desiredState,
    DefaultPipelineOptions,
  );
}

describe('SoftwarePipelineBuilder aspect ratio modes', () => {
  test('preserve mode scales to fit and pads', () => {
    const pipeline = buildPipeline(
      new FrameState({
        isAnamorphic: false,
        resizeMode: 'preserve',
        scaledSize: FrameSize.withDimensions(640, 360),
        paddedSize: FrameSize.withDimensions(640, 480),
        pixelFormat: new PixelFormatYuv420P(),
      }),
    );

    const filters = pipeline.getComplexFilter()!.filterChain.videoFilterSteps;
    const scale = filters.find((filter) => filter instanceof ScaleFilter);
    const pad = filters.find((filter) => filter instanceof PadFilter);

    expect(scale).toBeInstanceOf(ScaleFilter);
    expect(scale?.filter).toBe('scale=640:360:flags=fast_bilinear,setsar=1');
    expect(pad).toBeInstanceOf(PadFilter);
    expect(filters.some((filter) => filter instanceof CropFilter)).toBe(false);
  });

  test('crop mode scales to fill, center-crops, and places overlays on the cropped frame', () => {
    const pipeline = buildPipeline(
      new FrameState({
        isAnamorphic: false,
        resizeMode: 'crop',
        scaledSize: FrameSize.withDimensions(854, 480),
        paddedSize: FrameSize.withDimensions(640, 480),
        croppedSize: FrameSize.withDimensions(640, 480),
        pixelFormat: new PixelFormatYuv420P(),
      }),
      makeWatermarkInput(),
    );

    const filterChain = pipeline.getComplexFilter()!.filterChain;
    const filters = filterChain.videoFilterSteps;
    const scale = filters.find((filter) => filter instanceof ScaleFilter);
    const crop = filters.find((filter) => filter instanceof CropFilter);
    const overlay = filterChain.watermarkOverlayFilterSteps.find(
      (filter) => filter instanceof OverlayWatermarkFilter,
    );

    expect(scale?.filter).toBe('scale=854:480:flags=fast_bilinear,setsar=1');
    expect(crop).toBeInstanceOf(CropFilter);
    expect(crop?.filter).toBe('crop=640:480');
    expect(filters.some((filter) => filter instanceof PadFilter)).toBe(false);
    expect(overlay?.filter).toContain('x=W-w-64:y=H-h-48');
  });

  test('stretch mode scales directly to the target frame without pad or crop', () => {
    const pipeline = buildPipeline(
      new FrameState({
        isAnamorphic: false,
        resizeMode: 'stretch',
        scaledSize: FrameSize.withDimensions(640, 480),
        paddedSize: FrameSize.withDimensions(640, 480),
        pixelFormat: new PixelFormatYuv420P(),
      }),
    );

    const filters = pipeline.getComplexFilter()!.filterChain.videoFilterSteps;
    const scale = filters.find((filter) => filter instanceof ScaleFilter);

    expect(scale?.filter).toBe('scale=640:480:flags=fast_bilinear,setsar=1');
    expect(filters.some((filter) => filter instanceof PadFilter)).toBe(false);
    expect(filters.some((filter) => filter instanceof CropFilter)).toBe(false);
  });
});

describe('480i output', () => {
  const Sd = FrameSize.withDimensions(720, 480);

  function interlacedState(
    interlaced: Interlaced480Plan,
    sizes: Pick<FrameState, 'scaledSize' | 'paddedSize'> = {
      scaledSize: Sd,
      paddedSize: Sd,
    },
  ) {
    return new FrameState({
      isAnamorphic: false,
      resizeMode: 'crop',
      ...sizes,
      pixelFormat: new PixelFormatYuv420P(),
      videoFormat: 'mpeg2video',
      frameRate: 30000 / 1001,
      interlaced,
    });
  }

  function videoFilters(
    desiredState: FrameState,
    video: VideoInputSource = makeSdVideoInput(Sd),
  ) {
    return buildPipeline(desiredState, undefined, video)
      .getComplexFilter()!
      .filterChain.videoFilterSteps.filter((step) => step.filter !== '');
  }

  const filterStrings = (filters: ReturnType<typeof videoFilters>) =>
    filters.map((step) => step.filter);

  test('fields path passes the frame through', () => {
    const filters = videoFilters(interlacedState({ path: 'fields' }));

    expect(filterStrings(filters)).toEqual([
      'repeatfields',
      'setfield=tff,setsar=8/9',
    ]);
    expect(filters.some((step) => step instanceof ScaleFilter)).toBe(false);
    expect(filters.some((step) => step instanceof PadFilter)).toBe(false);
    expect(filters.some((step) => step instanceof DeinterlaceFilter)).toBe(
      false,
    );
  });

  test('the fields path always normalizes field order to TFF', () => {
    const chain = filterStrings(
      videoFilters(interlacedState({ path: 'fields' })),
    ).join(',');

    expect(chain.startsWith('repeatfields')).toBe(true);
    expect(chain).not.toContain('fieldorder');
    expect(chain.endsWith('setfield=tff,setsar=8/9')).toBe(true);
  });

  test('486 lines crop to 480 on an even line', () => {
    const chain = filterStrings(
      videoFilters(
        interlacedState({ path: 'fields' }),
        makeSdVideoInput(FrameSize.withDimensions(720, 486)),
      ),
    ).join(',');

    expect(chain).toContain('crop=iw:480:0:4');
  });

  test('704x486 crops to 480 lines before padding to 720', () => {
    const chain = filterStrings(
      videoFilters(
        interlacedState({ path: 'fields' }),
        makeSdVideoInput(FrameSize.withDimensions(704, 486)),
      ),
    ).join(',');

    expect(chain).toContain('crop=iw:480:0:4');
    expect(chain).toContain('pad=720:480:8:0');
  });

  test('crop path crops horizontally with interlace-aware scaling', () => {
    const chain = filterStrings(
      videoFilters(
        interlacedState({ path: 'fields', cropWidth: 540 }),
        makeSdVideoInput(Sd, '32:27'),
      ),
    ).join(',');

    expect(chain).toContain('crop=540:480,scale=720:480:interl=1');
  });

  test('field-rate path deinterlaces flagged frames, scales, then interlaces', () => {
    const filters = videoFilters(
      interlacedState(
        { path: 'fieldRate' },
        {
          scaledSize: FrameSize.withDimensions(720, 360),
          paddedSize: Sd,
        },
      ),
      makeVideoInput(),
    );

    expect(filters).toHaveLength(4);
    expect(filters[0]).toBeInstanceOf(FieldRateFilter);
    expect(filters[1]).toBeInstanceOf(ScaleFilter);
    expect(filters[2]).toBeInstanceOf(PadFilter);
    expect(filters[3]?.filter).toBe(
      'interlace=scan=tff:lowpass=linear,setfield=tff,setsar=8/9',
    );
  });
});
