import type { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import type { FrameSize } from '@/ffmpeg/builder/types.js';
import { Interlaced480Size } from '../../../interlaced/Interlaced480.ts';
import { FilterOption } from '../FilterOption.ts';

export class FieldPassFilter extends FilterOption {
  public readonly affectsFrameState = true;
  public readonly filter: string;

  constructor(
    private sourceSize: FrameSize,
    private cropWidth?: number,
  ) {
    super();
    this.filter = this.generateFilter();
  }

  nextState(currentState: FrameState): FrameState {
    return currentState.update({
      scaledSize: Interlaced480Size,
      paddedSize: Interlaced480Size,
    });
  }

  private generateFilter() {
    const parts = ['repeatfields', 'fieldorder=tff'];

    if (this.sourceSize.height === 486) {
      parts.push('crop=720:480:0:4');
    }

    if (this.sourceSize.width === 704) {
      parts.push('pad=720:480:8:0');
    }

    if (this.cropWidth) {
      parts.push(`crop=${this.cropWidth}:480`, 'scale=720:480:interl=1');
    }

    return parts.join(',');
  }
}
