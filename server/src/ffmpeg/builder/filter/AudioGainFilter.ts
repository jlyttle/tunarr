import { FilterOption } from './FilterOption.ts';

export class AudioGainFilter extends FilterOption {
  constructor(
    private gainDb: number,
    private sampleRate: number,
  ) {
    super();
  }

  public get filter(): string {
    return `volume=${this.gainDb}dB,alimiter=limit=0.794:level=disabled,aresample=${this.sampleRate * 1000}`;
  }
}
