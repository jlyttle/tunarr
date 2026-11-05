import type { MidRollConfig } from '@tunarr/types/api';
import { MidRollConfigSchema } from '@tunarr/types/api';
import { describe, expect, it } from 'vitest';
import {
  resolveBreakPoints,
  splitBreakDurations,
} from './midRollBreakRules.ts';

describe('MidRollConfigSchema', () => {
  const detectedBase = {
    breakRule: { type: 'detected' },
    maxBreaks: 0,
    minProgramDurationMs: 0,
  };

  it('accepts a detected rule with split slot flex and no break duration', () => {
    const result = MidRollConfigSchema.safeParse({
      ...detectedBase,
      splitSlotFlex: {},
    });

    expect(result.success).toBe(true);
    expect(result.data?.splitSlotFlex).toEqual({
      tailShare: 0.25,
      minTailMs: 60_000,
      minBreakMs: 60_000,
    });
  });

  it('still requires a break duration without split slot flex', () => {
    expect(MidRollConfigSchema.safeParse(detectedBase).success).toBe(false);
  });

  it('rejects tailShare above 1', () => {
    const result = MidRollConfigSchema.safeParse({
      ...detectedBase,
      splitSlotFlex: { tailShare: 1.5 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a negative minFirstBreakMs', () => {
    const result = MidRollConfigSchema.safeParse({
      ...detectedBase,
      splitSlotFlex: {},
      minFirstBreakMs: -1,
    });

    expect(result.success).toBe(false);
  });

  it('still parses a legacy interval config', () => {
    const result = MidRollConfigSchema.safeParse({
      intervalMs: 600_000,
      maxBreaks: 3,
      minProgramDurationMs: 0,
      breakDurationMs: 30_000,
    });

    expect(result.success).toBe(true);
  });
});

describe('resolveBreakPoints detected', () => {
  const programMs = 1_320_000;
  const base = MidRollConfigSchema.parse({
    breakRule: { type: 'detected' },
    maxBreaks: 0,
    minProgramDurationMs: 0,
    tailBufferMs: 0,
    splitSlotFlex: { tailShare: 0.25, minTailMs: 60_000, minBreakMs: 60_000 },
    strategy: 'lazy',
  });
  const offsets = (
    config: MidRollConfig,
    markers?: readonly number[],
  ): number[] | undefined =>
    resolveBreakPoints(programMs, config, markers)?.map((p) => p.offsetMs);

  it('uses a marker as a break point', () => {
    expect(resolveBreakPoints(programMs, base, [660_000])).toEqual([
      { offsetMs: 660_000 },
    ]);
  });

  it('returns null without markers', () => {
    expect(resolveBreakPoints(programMs, base)).toBeNull();
    expect(resolveBreakPoints(programMs, base, [])).toBeNull();
  });

  it('drops markers outside the program', () => {
    expect(offsets(base, [0, 660_000, 1_320_000, 1_400_000])).toEqual([
      660_000,
    ]);
  });

  it('sorts and deduplicates markers', () => {
    expect(offsets(base, [700_000, 660_000, 660_000])).toEqual([
      660_000, 700_000,
    ]);
  });

  it('drops markers before minFirstBreakMs', () => {
    const config = { ...base, minFirstBreakMs: 300_000 };
    expect(offsets(config, [155_000, 660_000])).toEqual([660_000]);
  });

  it('enforces minBreakIntervalMs from the previous kept break', () => {
    const config = { ...base, minBreakIntervalMs: 240_000 };
    expect(offsets(config, [300_000, 420_000, 600_000])).toEqual([
      300_000, 600_000,
    ]);
  });

  it('applies the tail buffer', () => {
    const config = { ...base, tailBufferMs: 120_000 };
    expect(offsets(config, [660_000, 1_250_000])).toEqual([660_000]);
  });

  it('applies maxBreaks last', () => {
    const config = { ...base, maxBreaks: 1 };
    expect(offsets(config, [300_000, 660_000])).toEqual([300_000]);
  });

  it('applies minFirstBreakMs to fixed_interval rules', () => {
    const config = MidRollConfigSchema.parse({
      breakRule: { type: 'fixed_interval', intervalMs: 300_000 },
      maxBreaks: 0,
      minProgramDurationMs: 0,
      breakDurationMs: 30_000,
      minFirstBreakMs: 400_000,
    });
    expect(offsets(config)).toEqual([600_000, 900_000, 1_200_000]);
  });
});

describe('splitBreakDurations', () => {
  const defaults = { tailShare: 0.25, minTailMs: 60_000, minBreakMs: 60_000 };

  it('shares the budget minus the tail across the breaks', () => {
    expect(splitBreakDurations(480_000, 2, defaults)).toEqual([
      180_000, 180_000,
    ]);
  });

  it('drops breaks until each one is long enough', () => {
    expect(splitBreakDurations(150_000, 2, defaults)).toEqual([90_000]);
  });

  it('plans no break when the budget cannot cover one', () => {
    expect(splitBreakDurations(100_000, 1, defaults)).toEqual([]);
  });

  it('uses the minimum break for an unbounded budget', () => {
    expect(splitBreakDurations(Infinity, 2, defaults)).toEqual([
      60_000, 60_000,
    ]);
  });
});
