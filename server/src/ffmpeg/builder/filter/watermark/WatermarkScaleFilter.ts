import { FilterOption } from '@/ffmpeg/builder/filter/FilterOption.js';
import type { FrameSize } from '@/ffmpeg/builder/types.js';
import type { Watermark } from '@tunarr/types';

export class WatermarkScaleFilter extends FilterOption {
  constructor(
    private resolution: FrameSize,
    private watermark: Watermark,
    private narrowPixels: boolean = false,
  ) {
    super();
  }

  public get filter(): string {
    const width = Math.round(
      (this.watermark.width / 100) * this.resolution.width,
    );
    if (this.narrowPixels) {
      return `scale=${width}:trunc(ih*${width}/iw*8/9/2)*2`;
    }
    return `scale=${width}:-2`;
  }
}
