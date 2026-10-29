import type { RotationParams, RotationTier } from '@tunarr/types/api';
import { DefaultRotationParams } from '@tunarr/types/api';

type TierNumbers = Record<RotationTier, number>;

export type ResolvedRotationParams = {
  tierWeights: TierNumbers;
  targetIntervalMs: TierNumbers;
  songGapMs: number;
  artistGapMs: number;
};

function mergeTiers(
  defaults: TierNumbers,
  partial: Partial<TierNumbers> | undefined,
): TierNumbers {
  return {
    heavy: partial?.heavy ?? defaults.heavy,
    medium: partial?.medium ?? defaults.medium,
    light: partial?.light ?? defaults.light,
  };
}

export function resolveRotationParams(
  partial?: RotationParams,
): ResolvedRotationParams {
  return {
    tierWeights: mergeTiers(
      DefaultRotationParams.tierWeights,
      partial?.tierWeights,
    ),
    targetIntervalMs: mergeTiers(
      DefaultRotationParams.targetIntervalMs,
      partial?.targetIntervalMs,
    ),
    songGapMs: partial?.songGapMs ?? DefaultRotationParams.songGapMs,
    artistGapMs: partial?.artistGapMs ?? DefaultRotationParams.artistGapMs,
  };
}
