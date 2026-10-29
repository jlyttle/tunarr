import type { CondensedContentProgram } from '@tunarr/types';
import { sortBy } from 'lodash-es';
import type { Random } from 'random-js';
import type { Maybe, Nullable } from '../../../types/util.ts';
import type { IterationState, ProgramIterator } from '../ProgramIterator.ts';
import type { SlotSchedulerProgram } from '../slotSchedulerUtil.ts';
import { artistKeys, tierOf } from './artistKeys.ts';
import type { ResolvedRotationParams } from './resolveRotationParams.ts';
import type { RotationState } from './RotationState.ts';

const SONG_AND_ARTIST_GAP = 2;
const SONG_GAP_ONLY = 1;

type RotationEntry = {
  program: SlotSchedulerProgram;
  minted: CondensedContentProgram;
  artistKeys: string[];
  tierWeight: number;
  targetIntervalMs: number;
  // Scratch values rewritten by every pick.
  level: number;
  weight: number;
  lastAired: number;
};

export function recoveryFactor(
  sinceLastAiredMs: Maybe<number>,
  targetIntervalMs: number,
): number {
  if (sinceLastAiredMs === undefined) {
    return 1;
  }
  const ratio = Math.min(1, Math.max(0, sinceLastAiredMs) / targetIntervalMs);
  return ratio * ratio;
}

function toEntry(
  program: SlotSchedulerProgram,
  params: ResolvedRotationParams,
): RotationEntry {
  const tier = tierOf((program.tags ?? []).map((t) => t.tag.tag));
  return {
    program,
    minted: { type: 'content', duration: program.duration, id: program.uuid },
    artistKeys: artistKeys(program.artistName),
    tierWeight: params.tierWeights[tier],
    targetIntervalMs: params.targetIntervalMs[tier],
    level: 0,
    weight: 0,
    lastAired: -Infinity,
  };
}

export class WeightedRotationProgramIterator
  implements ProgramIterator<CondensedContentProgram>
{
  private readonly entries: RotationEntry[];
  private picked: Nullable<RotationEntry> = null;
  private pickedAtVersion = -1;
  private lastTimeCursor = 0;

  constructor(
    programs: SlotSchedulerProgram[],
    private readonly state: RotationState,
    private readonly random: Random,
    private readonly params: ResolvedRotationParams,
  ) {
    this.entries = sortBy(programs, (p) => p.uuid).map((p) =>
      toEntry(p, params),
    );
  }

  current(iterState: IterationState): Nullable<CondensedContentProgram> {
    this.lastTimeCursor = iterState.timeCursor;
    if (this.pickedAtVersion !== this.state.version) {
      this.picked = null;
    }
    if (this.picked === null) {
      this.picked = this.pick(iterState.timeCursor);
      this.pickedAtVersion = this.state.version;
    }
    return this.picked?.minted ?? null;
  }

  next(): void {
    if (this.picked !== null) {
      this.state.record(this.picked.program, this.lastTimeCursor);
    }
    this.picked = null;
  }

  reset(): void {
    this.picked = null;
  }

  fork(): ProgramIterator<CondensedContentProgram> {
    return this;
  }

  private pick(atMs: number): Nullable<RotationEntry> {
    if (this.entries.length === 0) {
      return null;
    }
    for (const entry of this.entries) {
      this.score(entry, atMs);
    }
    return (
      this.weightedPick(SONG_AND_ARTIST_GAP) ??
      this.weightedPick(SONG_GAP_ONLY) ??
      this.leastRecentlyAired(0)
    );
  }

  private score(entry: RotationEntry, atMs: number): void {
    const lastAired = this.state.songLastAired.get(entry.program.uuid);
    const since = lastAired === undefined ? undefined : atMs - lastAired;
    entry.lastAired = lastAired ?? -Infinity;
    entry.level = this.gapLevel(entry, since, atMs);
    entry.weight =
      entry.tierWeight * recoveryFactor(since, entry.targetIntervalMs);
  }

  private gapLevel(
    entry: RotationEntry,
    sinceSongMs: Maybe<number>,
    atMs: number,
  ): number {
    if (sinceSongMs !== undefined && sinceSongMs < this.params.songGapMs) {
      return 0;
    }
    return this.artistGapSatisfied(entry, atMs)
      ? SONG_AND_ARTIST_GAP
      : SONG_GAP_ONLY;
  }

  private artistGapSatisfied(entry: RotationEntry, atMs: number): boolean {
    for (const key of entry.artistKeys) {
      const lastAired = this.state.artistLastAired.get(key);
      if (
        lastAired !== undefined &&
        atMs - lastAired < this.params.artistGapMs
      ) {
        return false;
      }
    }
    return true;
  }

  private weightedPick(minLevel: number): Nullable<RotationEntry> {
    let count = 0;
    let sum = 0;
    for (const entry of this.entries) {
      if (entry.level >= minLevel) {
        count++;
        sum += entry.weight;
      }
    }
    if (count === 0) {
      return null;
    }
    if (sum <= 0) {
      return this.leastRecentlyAired(minLevel);
    }
    return this.drawWeighted(minLevel, sum);
  }

  private drawWeighted(minLevel: number, sum: number): Nullable<RotationEntry> {
    const target = this.random.real(0, sum, false);
    let cumulative = 0;
    let lastEligible: Nullable<RotationEntry> = null;
    for (const entry of this.entries) {
      if (entry.level < minLevel || entry.weight <= 0) {
        continue;
      }
      cumulative += entry.weight;
      lastEligible = entry;
      if (target < cumulative) {
        return entry;
      }
    }
    return lastEligible;
  }

  private leastRecentlyAired(minLevel: number): Nullable<RotationEntry> {
    let oldest = Infinity;
    let ties = 0;
    for (const entry of this.entries) {
      if (entry.level < minLevel) {
        continue;
      }
      if (entry.lastAired < oldest) {
        oldest = entry.lastAired;
        ties = 1;
      } else if (entry.lastAired === oldest) {
        ties++;
      }
    }
    if (ties === 0) {
      return null;
    }
    return this.nthAiredAt(minLevel, oldest, this.random.integer(0, ties - 1));
  }

  private nthAiredAt(
    minLevel: number,
    lastAired: number,
    n: number,
  ): Nullable<RotationEntry> {
    let seen = 0;
    for (const entry of this.entries) {
      if (entry.level >= minLevel && entry.lastAired === lastAired) {
        if (seen === n) {
          return entry;
        }
        seen++;
      }
    }
    return null;
  }
}
