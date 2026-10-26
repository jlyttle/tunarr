import { FilterOption } from '../FilterOption.ts';

export class FieldRateFilter extends FilterOption {
  public readonly filter =
    'bwdif=mode=send_field:parity=auto:deint=interlaced,fps=60000/1001';
}
