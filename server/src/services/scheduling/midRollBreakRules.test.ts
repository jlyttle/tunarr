import { MidRollConfigSchema } from '@tunarr/types/api';
import { describe, expect, it } from 'vitest';
import { resolveBreakPoints } from './midRollBreakRules.ts';

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

describe('resolveBreakPoints', () => {
  const detectedBase = {
    breakRule: { type: 'detected' },
    maxBreaks: 0,
    minProgramDurationMs: 0,
  };

  it('returns null for a detected rule on a long program', () => {
    const config = MidRollConfigSchema.parse({
      ...detectedBase,
      splitSlotFlex: {},
    });

    expect(resolveBreakPoints(2 * 60 * 60 * 1000, config)).toBeNull();
  });
});
