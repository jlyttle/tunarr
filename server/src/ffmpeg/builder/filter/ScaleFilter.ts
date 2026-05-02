import type { FfmpegState } from '@/ffmpeg/builder/state/FfmpegState.js';
import type { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import { FrameDataLocation, type FrameSize } from '@/ffmpeg/builder/types.js';
import { isNonEmptyString } from '@tunarr/shared/util';
import { HardwareAccelerationMode } from '../../../db/schema/TranscodeConfig.ts';
import { FilterOption } from './FilterOption.ts';
import { HardwareDownloadFilter } from './HardwareDownloadFilter.ts';
import { HardwareDownloadCudaFilter } from './nvidia/HardwareDownloadCudaFilter.ts';

export class ScaleFilter extends FilterOption {
  private hardwareDownloadFilter?: FilterOption;
  readonly filter: string;

  readonly affectsFrameState = true;

  constructor(
    private currentState: FrameState,
    private ffmpegState: FfmpegState,
    private desiredScaledSize: FrameSize,
  ) {
    super();
    this.filter = this.generateFilter();
  }

  static create(
    currentState: FrameState,
    ffmpegState: FfmpegState,
    desiredScaledSize: FrameSize,
  ) {
    return new ScaleFilter(currentState, ffmpegState, desiredScaledSize);
  }

  private generateFilter(): string {
    if (this.currentState.scaledSize.equals(this.desiredScaledSize)) {
      return '';
    }

    let scaleFilter: string;
    if (this.currentState.isAnamorphic) {
      scaleFilter = `scale=iw*sar:ih,setsar=1,scale=${this.desiredScaledSize.width}:${this.desiredScaledSize.height}:flags=${this.ffmpegState.softwareScalingAlgorithm}`;
    } else {
      scaleFilter = `scale=${this.desiredScaledSize.width}:${this.desiredScaledSize.height}:flags=${this.ffmpegState.softwareScalingAlgorithm},setsar=1`;
    }

    if (this.currentState.frameDataLocation === FrameDataLocation.Hardware) {
      const hwdownload =
        this.ffmpegState.decoderHwAccelMode === HardwareAccelerationMode.Cuda
          ? new HardwareDownloadCudaFilter(this.currentState, null)
          : new HardwareDownloadFilter(this.currentState);
      this.hardwareDownloadFilter = hwdownload;
      const hwdownloadFilter = hwdownload.filter;
      if (isNonEmptyString(hwdownloadFilter)) {
        scaleFilter = `${hwdownloadFilter},${scaleFilter}`;
      }
    }

    return scaleFilter;
  }

  nextState(currentState: FrameState): FrameState {
    currentState =
      this.hardwareDownloadFilter?.nextState(currentState) ?? currentState;
    return currentState.update({
      scaledSize: this.desiredScaledSize,
      paddedSize: this.desiredScaledSize,
      isAnamorphic: false,
      frameDataLocation: FrameDataLocation.Software,
    });
  }
}
