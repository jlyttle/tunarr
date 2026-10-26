import { FilterOption } from '../FilterOption.ts';

export class InterlaceTffFilter extends FilterOption {
  public readonly filter: string;

  constructor(fromFieldRate: boolean) {
    super();
    const interlace = fromFieldRate ? 'interlace=scan=tff:lowpass=linear,' : '';
    this.filter = `${interlace}setfield=tff,setsar=8/9`;
  }
}
