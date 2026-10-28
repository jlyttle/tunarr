import { FileStreamSource } from '@/stream/types.js';
import type { LabelRender } from '@/stream/musicVideoLabel.js';
import dayjs from '@/util/dayjs.js';
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
import { SubtitlesInputSource } from '../../input/SubtitlesInputSource.ts';
import { VideoInputSource } from '../../input/VideoInputSource.ts';
import { WatermarkInputSource } from '../../input/WatermarkInputSource.ts';
import { MusicVideoLabelFilter } from '../../filter/MusicVideoLabelFilter.ts';
import {
  EmbeddedSubtitleStream,
  StillImageStream,
  SubtitleMethods,
  VideoStream,
} from '../../MediaStream.ts';
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
  subtitle: SubtitlesInputSource | null = null,
  start?: number,
) {
  const builder = new SoftwarePipelineBuilder(
    video,
    null,
    watermark ?? null,
    subtitle,
    null,
    EmptyFfmpegCapabilities,
  );

  return builder.build(
    FfmpegState.create({
      version: { versionString: '7.1.1', isUnknown: false },
      ...(start !== undefined && { start: dayjs.duration(start, 'seconds') }),
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
      'fieldorder=tff,repeatfields',
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

    // repeatfields rejects BFF frames, so BFF must become TFF before it
    expect(chain.startsWith('fieldorder=tff,repeatfields')).toBe(true);
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

describe('480i watermark', () => {
  const Sd = FrameSize.withDimensions(720, 480);

  function overlayFilter(
    watermark: Partial<Watermark>,
    interlaced: Interlaced480Plan | null = { path: 'fieldRate' },
  ) {
    const desiredState = new FrameState({
      isAnamorphic: false,
      scaledSize: Sd,
      paddedSize: Sd,
      pixelFormat: new PixelFormatYuv420P(),
      videoFormat: 'mpeg2video',
      interlaced,
    });
    return buildPipeline(desiredState, makeWatermarkInput(watermark))
      .getComplexFilter()!
      .filterChain.watermarkOverlayFilterSteps.find(
        (step) => step instanceof OverlayWatermarkFilter,
      )!.filter;
  }

  test('480i watermark sits on an even line', () => {
    expect(
      overlayFilter({ position: 'bottom-right', verticalMargin: 10 }),
    ).toContain('y=trunc((H-h-48)/2)*2');
    expect(
      overlayFilter({ position: 'top-left', verticalMargin: 5 }),
    ).toContain('y=24');
    expect(
      overlayFilter({ position: 'top-left', verticalMargin: 6.9 }),
    ).toContain('y=32');
  });

  test('a progressive watermark keeps its plain position', () => {
    expect(
      overlayFilter({ position: 'bottom-right', verticalMargin: 10 }, null),
    ).toContain('y=H-h-48');
  });
});

describe('software watermark looping', () => {
  const Sd = FrameSize.withDimensions(720, 480);

  function watermarkInputOptions(watermark: Partial<Watermark>) {
    const input = makeWatermarkInput(watermark);
    buildPipeline(
      new FrameState({
        isAnamorphic: false,
        scaledSize: Sd,
        paddedSize: Sd,
        pixelFormat: new PixelFormatYuv420P(),
      }),
      input,
    );
    return input.inputOptions.flatMap((option) => option.options(input));
  }

  test('software watermark still image with fade loops its input', () => {
    const options = watermarkInputOptions({
      fadeConfig: [{ periodMins: 5, leadingEdge: true }],
    });
    expect(options).toEqual(expect.arrayContaining(['-loop', '1']));
  });

  test('software watermark still image without fade does not loop', () => {
    expect(watermarkInputOptions({})).not.toContain('-loop');
  });
});

describe('music video label', () => {
  const Sd = FrameSize.withDimensions(720, 480);
  const label: LabelRender = {
    lines: ['2Pac', '"I Ain\'t Mad At Cha"', 'All Eyez On Me', 'Death Row'],
    windows: [
      [5, 13],
      [220, 240],
    ],
    fontFile: '/config/tunarr/fonts/KabelBlack.ttf',
  };

  function labelState(
    interlaced: Interlaced480Plan | null,
    musicVideoLabel: LabelRender | null = label,
  ) {
    return new FrameState({
      isAnamorphic: false,
      resizeMode: 'crop',
      scaledSize: interlaced ? FrameSize.withDimensions(720, 360) : Sd,
      paddedSize: Sd,
      pixelFormat: new PixelFormatYuv420P(),
      videoFormat: 'mpeg2video',
      frameRate: 30000 / 1001,
      interlaced,
      musicVideoLabel,
    });
  }

  function chain(
    desiredState: FrameState,
    video: VideoInputSource = makeVideoInput(),
    subtitle: SubtitlesInputSource | null = null,
    start?: number,
  ) {
    return buildPipeline(desiredState, undefined, video, subtitle, start)
      .getComplexFilter()!
      .filterChain.videoFilterSteps.filter((step) => step.filter !== '');
  }

  const labelFilter = (steps: ReturnType<typeof chain>) =>
    steps.find((step) => step instanceof MusicVideoLabelFilter)?.filter ?? '';

  test('field-rate path draws the label after scaling and before interlacing', () => {
    const steps = chain(labelState({ path: 'fieldRate' }));
    const labelIndex = steps.findIndex(
      (step) => step instanceof MusicVideoLabelFilter,
    );

    expect(labelIndex).toBe(3);
    expect(steps[2]).toBeInstanceOf(PadFilter);
    expect(steps[4]?.filter).toBe(
      'interlace=scan=tff:lowpass=linear,setfield=tff,setsar=8/9',
    );
    expect(labelFilter(steps)).toContain('r=60000/1001');
  });

  test('fields path draws the label before setfield', () => {
    const steps = chain(
      labelState({ path: 'fields' }),
      makeSdVideoInput(Sd),
    );

    expect(steps.map((step) => step.constructor.name)).toEqual([
      'FieldPassFilter',
      'MusicVideoLabelFilter',
      'InterlaceTffFilter',
    ]);
    expect(steps[2]?.filter).toBe('setfield=tff,setsar=8/9');
    expect(labelFilter(steps)).toContain('r=30000/1001');
  });

  test('progressive path draws the label after crop', () => {
    const steps = chain(
      new FrameState({
        isAnamorphic: false,
        resizeMode: 'crop',
        scaledSize: FrameSize.withDimensions(854, 480),
        paddedSize: FrameSize.withDimensions(640, 480),
        croppedSize: FrameSize.withDimensions(640, 480),
        pixelFormat: new PixelFormatYuv420P(),
        musicVideoLabel: label,
      }),
    );

    expect(steps.at(-1)).toBeInstanceOf(MusicVideoLabelFilter);
    expect(steps.at(-2)).toBeInstanceOf(CropFilter);
    expect(labelFilter(steps)).toContain(
      'color=c=black@0:s=640x480:r=30,format=yuva420p',
    );
    expect(labelFilter(steps)).toContain('scale=640:480[mvlt]');
  });

  test('renders on a 640x480 canvas scaled to 720x480 and overlaid', () => {
    const filter = labelFilter(chain(labelState({ path: 'fieldRate' })));

    expect(filter).toMatch(
      /^null\[mvlv\];color=c=black@0:s=640x480:r=60000\/1001,format=yuva420p,drawtext=/,
    );
    expect(filter).toContain(',scale=720:480[mvlt];[mvlv][mvlt]overlay=');
    expect(filter).toContain(
      "overlay=shortest=1:enable='between(t,5,13)+between(t,220,240)'",
    );
  });

  test('draws one escaped drawtext per line, bottom line on the title-safe baseline', () => {
    const filter = labelFilter(chain(labelState({ path: 'fieldRate' })));
    const drawtexts = filter.split(',').filter((part) => part.startsWith('drawtext='));

    expect(drawtexts.map((part) => /:y=(\d+)-ascent/.exec(part)?.[1])).toEqual(
      ['360', '384', '408', '432'],
    );
    expect(filter).toContain(
      'drawtext=fontfile=/config/tunarr/fonts/KabelBlack.ttf:expansion=none:text=2Pac:fontsize=20:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=64:y=360-ascent:',
    );
    expect(filter).toContain(
      'text="I Ain\\\\\\\'t Mad At Cha":',
    );
    expect(filter).toContain(
      "alpha='clip(min(t-5,13-t)/0.5,0,1)+clip(min(t-220,240-t)/0.5,0,1)':",
    );
    expect(filter).toContain(
      ":enable='between(t,5,13)+between(t,220,240)'",
    );
  });

  test('shifts the label clock to source time when text subtitles force -copyts', () => {
    const subtitle = new SubtitlesInputSource(
      new FileStreamSource('/path/to/video.mkv'),
      [new EmbeddedSubtitleStream('subrip', 2, SubtitleMethods.Burn)],
      SubtitleMethods.Burn,
    );
    const filter = labelFilter(
      chain(labelState({ path: 'fieldRate' }), makeVideoInput(), subtitle, 30),
    );

    expect(filter).toContain('format=yuva420p,setpts=PTS+30/TB,drawtext=');
    expect(filter).toContain(
      "overlay=shortest=1:enable='between(t,35,43)+between(t,250,270)'",
    );
  });

  test('no label leaves the chain unchanged', () => {
    for (const interlaced of [
      { path: 'fieldRate' },
      { path: 'fields' },
      null,
    ] satisfies Array<Interlaced480Plan | null>) {
      const video = () =>
        interlaced?.path === 'fields' ? makeSdVideoInput(Sd) : makeVideoInput();
      const withNull = chain(labelState(interlaced, null), video());
      const withoutField = chain(
        new FrameState({ ...labelState(interlaced, null), musicVideoLabel: undefined }),
        video(),
      );

      expect(withNull.some((s) => s instanceof MusicVideoLabelFilter)).toBe(false);
      expect(withNull.map((s) => s.filter)).toEqual(
        withoutField.map((s) => s.filter),
      );
    }
  });
});
