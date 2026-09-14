import type { EvaluationArtifact } from '../services/break-analysis/BreakEvaluation.ts';
import {
  BreakDetectorConfigSchema,
  type BreakCandidate,
} from '@tunarr/types/schemas';

export function candidateFixture(): BreakCandidate {
  return {
    timestampMs: 450300,
    confidence: 'high',
    accepted: true,
    reasons: [],
    evidence: {
      blackStartMs: 450000,
      blackEndMs: 450600,
      silenceOverlapMs: 600,
      fade: true,
      visualDifference: 0.4,
      motionBefore: 0.02,
      motionAfter: 0.02,
      audioContext: true,
      completeContext: true,
    },
  };
}

export function evaluationFixture(): EvaluationArtifact {
  return {
    formatVersion: 1,
    datasetId: '<script>alert(1)</script>',
    kind: 'synthetic',
    split: 'development',
    toleranceMs: 2000,
    createdAt: 0,
    episodes: [
      {
        id: 'episode',
        expectedBreaks: [450000],
        labels: [],
        result: {
          id: 'test',
          createdAt: 0,
          detectorVersion: 'test',
          configHash: 'test',
          config: BreakDetectorConfigSchema.parse({}),
          status: 'completed',
          sourceFingerprint: 'test',
          runtimeMs: 1440000,
          qualified: false,
          stale: false,
          usableBreaks: [],
          candidates: [],
        },
      },
    ],
  };
}
