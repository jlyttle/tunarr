import { MidRollConfigSchema } from '@tunarr/types/api';
import { describe, expect, it } from 'vitest';

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
});
