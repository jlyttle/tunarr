import { HardwareDownloadFilter } from '@/ffmpeg/builder/filter/HardwareDownloadFilter.js';
import { HardwareDownloadCudaFilter } from '@/ffmpeg/builder/filter/nvidia/HardwareDownloadCudaFilter.js';
import type { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import type { FrameSize } from '@/ffmpeg/builder/types.js';
import { FrameDataLocation } from '@/ffmpeg/builder/types.js';
import { isNonEmptyString } from '@/util/index.js';
import { PixelFormatCuda } from '../format/PixelFormat.ts';
import { FilterOption } from './FilterOption.ts';

export class CropFilter extends FilterOption {
  public readonly affectsFrameState = true;
  public readonly filter: string;

  private readonly hardwareDownloadFilter: FilterOption;

  constructor(
    private currentState: FrameState,
    private desiredCropSize: FrameSize,
  ) {
    super();
    this.hardwareDownloadFilter =
      currentState.pixelFormat instanceof PixelFormatCuda
        ? new HardwareDownloadCudaFilter(currentState, null)
        : new HardwareDownloadFilter(currentState);
    this.filter = this.generateFilter();
  }

  nextState(currentState: FrameState): FrameState {
    const nextState = this.hardwareDownloadFilter
      .nextState(currentState)
      .update({
        croppedSize: this.desiredCropSize,
        paddedSize: this.desiredCropSize,
        frameDataLocation: FrameDataLocation.Software,
      });

    return nextState;
  }

  private generateFilter() {
    const crop = `crop=${this.desiredCropSize.width}:${this.desiredCropSize.height}`;
    const download = this.hardwareDownloadFilter.filter;

    if (
      this.currentState.frameDataLocation === FrameDataLocation.Hardware &&
      isNonEmptyString(download)
    ) {
      return `${download},${crop}`;
    }

    return crop;
  }
}
