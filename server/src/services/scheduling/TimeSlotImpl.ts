import type { CondensedChannelProgram, FillerProgram } from '@tunarr/types';
import type { TimeSlot } from '@tunarr/types/api';
import { isNonEmptyString } from '@tunarr/shared/util';
import { isNil } from 'lodash-es';
import type { Random } from 'random-js';
import type { ProgramIterator } from './ProgramIterator.js';
import { SlotImpl } from './SlotImpl.js';

export type GuideFields = Pick<
  CondensedChannelProgram,
  'guideTitle' | 'guideDescription'
>;

export class TimeSlotImpl<
  ProgramT extends CondensedChannelProgram,
> extends SlotImpl<TimeSlot, ProgramT> {
  constructor(
    slot: TimeSlot,
    iterator: ProgramIterator<ProgramT>,
    random: Random,
    fillerIteratorsByListId: Record<
      string,
      ProgramIterator<FillerProgram>
    > = {},
  ) {
    super(slot, iterator, random, fillerIteratorsByListId);
  }

  get startTime() {
    return this.slot.startTime;
  }

  get padMs() {
    const pad = this.slot.padMs;
    if (isNil(pad)) {
      return pad;
    }
    return pad > 0 ? pad : undefined;
  }

  get overflow() {
    return this.slot.overflow;
  }

  get latenessMs() {
    return this.slot.latenessMs;
  }

  get guideFields(): GuideFields {
    if (!isNonEmptyString(this.slot.guideTitle)) {
      return {};
    }
    return {
      guideTitle: this.slot.guideTitle,
      guideDescription: this.slot.guideDescription,
    };
  }
}
