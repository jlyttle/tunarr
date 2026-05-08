import type { FrameState } from '../../state/FrameState.ts';
import type { FrameSize } from '../../types.ts';
import { ScaleCudaFilter } from './ScaleCudaFilter.ts';

// Going nto take the easy way right now and just extend the Cuda filter
export class ScaleNppFilter extends ScaleCudaFilter {
  protected filterName: string = 'scale_npp';

  constructor(
    currentState: FrameState,
    scaledSize: FrameSize,
    passthrough: boolean = false,
  ) {
    super(currentState, scaledSize, passthrough);
    this.filter = this.generateFilter();
  }
}
