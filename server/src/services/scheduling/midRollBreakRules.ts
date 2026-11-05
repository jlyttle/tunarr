import type { MidRollBreakRule, MidRollConfig } from '@tunarr/types/api';

export type BreakPoint = { offsetMs: number };

/**
 * The shortest break the config allows. A break cut down to fit a slot must
 * still be at least this long.
 */
export function minimumBreakDuration(config: MidRollConfig): number {
  return config.breakDurationMinMs ?? config.breakDurationMs ?? 0;
}

export function resolveBreakDuration(
  config: MidRollConfig,
  random?: { integer(min: number, max: number): number },
): number {
  if (
    config.breakDurationMinMs !== undefined &&
    config.breakDurationMaxMs !== undefined
  ) {
    if (!random) {
      return config.breakDurationMaxMs;
    }
    return random.integer(config.breakDurationMinMs, config.breakDurationMaxMs);
  }

  if (config.breakDurationMs === undefined) {
    throw new Error(
      'MidRollConfig must have either breakDurationMs or breakDurationMinMs/breakDurationMaxMs',
    );
  }

  return config.breakDurationMs;
}

function detectedOffsets(
  programDurationMs: number,
  markersMs: readonly number[],
): number[] {
  const inside = markersMs.filter((m) => m > 0 && m < programDurationMs);
  return [...new Set(inside)].sort((a, b) => a - b);
}

function dropBefore(offsets: number[], minFirstBreakMs: number): number[] {
  return offsets.filter((offset) => offset >= minFirstBreakMs);
}

function enforceMinInterval(
  offsets: number[],
  minIntervalMs: number,
): number[] {
  const kept: number[] = [];
  for (const offset of offsets) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || offset - previous >= minIntervalMs) {
      kept.push(offset);
    }
  }
  return kept;
}

export function resolveBreakPoints(
  programDurationMs: number,
  config: MidRollConfig,
  markersMs?: readonly number[],
): BreakPoint[] | null {
  if (programDurationMs < config.minProgramDurationMs) return null;

  let breakRule: MidRollBreakRule;
  if (config.breakRule) {
    breakRule = config.breakRule;
  } else if (config.intervalMs !== undefined) {
    breakRule = { type: 'fixed_interval', intervalMs: config.intervalMs };
  } else {
    throw new Error(
      'MidRollConfig must have either breakRule or intervalMs when enabled',
    );
  }

  let offsets: number[];

  switch (breakRule.type) {
    case 'fixed_interval': {
      offsets = [];
      let offset = breakRule.intervalMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += breakRule.intervalMs;
      }
      break;
    }
    case 'percentage': {
      offsets = breakRule.points.map((p) =>
        Math.round((programDurationMs * p) / 100),
      );
      offsets.sort((a, b) => a - b);
      break;
    }
    case 'initial_then_interval': {
      offsets = [];
      let offset = breakRule.initialDelayMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += breakRule.intervalMs;
      }
      break;
    }
    case 'detected':
      offsets = detectedOffsets(programDurationMs, markersMs ?? []);
      break;
  }

  // Use max of range for conservative filtering
  const breakDuration = config.splitSlotFlex ? 0 : resolveBreakDuration(config);
  const tailBuffer = config.tailBufferMs ?? 0;

  offsets = offsets.filter(
    (offset) => programDurationMs - offset - breakDuration >= tailBuffer,
  );

  if (config.minFirstBreakMs !== undefined) {
    offsets = dropBefore(offsets, config.minFirstBreakMs);
  }

  if (config.minBreakIntervalMs !== undefined) {
    offsets = enforceMinInterval(offsets, config.minBreakIntervalMs);
  }

  if (config.maxBreaks > 0) {
    offsets = offsets.slice(0, config.maxBreaks);
  }

  if (offsets.length === 0) return null;

  return offsets.map((offsetMs) => ({ offsetMs }));
}

export type SplitSlotFlex = NonNullable<MidRollConfig['splitSlotFlex']>;

/**
 * Sizes breaks from a program's share of the slot's spare time. A tail of the
 * budget is kept back, and the rest is shared evenly. Breaks are dropped from
 * the end until each is at least the minimum break. Each break is capped at
 * the longest break, and the time the cap frees stays unspent.
 */
export function splitBreakDurations(
  budgetMs: number,
  breakCount: number,
  split: SplitSlotFlex,
): number[] {
  if (!Number.isFinite(budgetMs)) {
    return Array<number>(breakCount).fill(split.minBreakMs);
  }
  const capped = (ms: number) => Math.min(ms, split.maxBreakMs ?? Infinity);
  const tail = Math.min(
    budgetMs,
    Math.max(split.minTailMs, budgetMs * split.tailShare),
  );
  for (let n = breakCount; n >= 1; n--) {
    const each = Math.floor((budgetMs - tail) / n);
    if (each >= split.minBreakMs) {
      return Array<number>(n).fill(capped(each));
    }
  }
  return [];
}
