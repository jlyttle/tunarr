import type { SlotSchedulerProgram } from '../slotSchedulerUtil.ts';
import { artistKeys } from './artistKeys.ts';

export class RotationState {
  readonly songLastAired = new Map<string, number>();
  readonly artistLastAired = new Map<string, number>();

  record(program: SlotSchedulerProgram, atMs: number): void {
    this.songLastAired.set(program.uuid, atMs);
    for (const key of artistKeys(program.artistName)) {
      this.artistLastAired.set(key, atMs);
    }
  }
}
