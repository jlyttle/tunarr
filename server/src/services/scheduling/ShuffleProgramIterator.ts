import type {
  CondensedChannelProgram,
  CondensedContentProgram,
} from '@tunarr/types';
import type { CondensedCustomProgram } from '@tunarr/types/schemas';
import { partition } from 'lodash-es';
import type { Random } from 'random-js';
import {
  IndexBasedProgramIterator,
  type ProgramIterator,
} from './ProgramIterator.ts';
import {
  createIndexByIdMap,
  type SlotSchedulerProgram,
} from './slotSchedulerUtil.ts';

function shuffleWithPlayFirst(
  programs: SlotSchedulerProgram[],
  random: Random,
  playFirstProgramIds: string[] = [],
) {
  const playFirstIds = new Set(playFirstProgramIds);
  const [playFirst, rest] = partition(programs, (program) =>
    playFirstIds.has(program.uuid),
  );
  if (playFirst.length === 0) {
    return random.shuffle(programs);
  }
  return [...random.shuffle(playFirst), ...random.shuffle(rest)];
}

abstract class ShuffleProgramIterator<
  ProgramT extends CondensedChannelProgram,
> extends IndexBasedProgramIterator<ProgramT> {
  constructor(
    programs: SlotSchedulerProgram[],
    protected random: Random,
    playFirstProgramIds?: string[],
  ) {
    super(shuffleWithPlayFirst(programs, random, playFirstProgramIds));
  }

  next() {
    super.next();
    // IndexBasedProgramIterator#next wraps the position modulo the list
    // length, so position === 0 means we just completed a full pass.
    // Reshuffle so the next pass isn't a replay of the previous one.
    if (this.position === 0) {
      this.programs = this.random.shuffle([...this.programs]);
    }
  }

  reset(): void {
    this.programs = this.random.shuffle(this.programs);
    this.position = 0;
  }
}

export class ContentProgramShuffleIterator extends ShuffleProgramIterator<CondensedContentProgram> {
  protected mint(program: SlotSchedulerProgram): CondensedContentProgram {
    return {
      type: 'content',
      duration: program.duration,
      id: program.uuid,
    };
  }
}

export class ProgramShuffleIteratorImpl<
  ProgramT extends CondensedChannelProgram,
> extends ShuffleProgramIterator<ProgramT> {
  constructor(
    programs: SlotSchedulerProgram[],
    random: Random,
    private minterFunc: (program: SlotSchedulerProgram) => ProgramT,
  ) {
    super(programs, random);
  }

  protected mint(program: SlotSchedulerProgram): ProgramT {
    return this.minterFunc(program);
  }

  fork(): ProgramIterator<ProgramT> {
    const forked = new ProgramShuffleIteratorImpl(
      [...this.programs],
      this.random,
      this.minterFunc,
    );
    return forked;
  }
}

export class CustomProgramShuffleIterator extends ShuffleProgramIterator<CondensedCustomProgram> {
  private indexById!: Record<string, number>;

  constructor(
    private customShowId: string,
    programs: SlotSchedulerProgram[],
    random: Random,
    playFirstProgramIds?: string[],
  ) {
    super(programs, random, playFirstProgramIds);
    this.indexById = createIndexByIdMap(programs, customShowId);
  }

  protected mint(program: SlotSchedulerProgram): CondensedCustomProgram {
    return {
      customShowId: this.customShowId,
      duration: program.duration,
      id: program.uuid,
      index: this.indexById[program.uuid]!,
      type: 'custom',
    };
  }
}
