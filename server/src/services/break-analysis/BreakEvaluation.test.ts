import { describe, expect, test } from 'vitest';
import {
  matchBreakpoints,
  qualificationDetails,
  renderEvaluation,
  summarizeEvaluation,
} from './BreakEvaluation.ts';
import {
  evaluationFixture,
  candidateFixture,
} from '../../testing/BreakAnalysisFixtures.ts';

describe('offline evaluation', () => {
  test('maximizes one-to-one matches before minimizing timing error', () => {
    const result = matchBreakpoints([1000, 3000], [2600, 4800], 2000);
    expect(result.matches).toHaveLength(2);
    expect(result.falsePositives).toEqual([]);
    expect(
      matchBreakpoints([1000], [1001, 1000], 2000).matches[0]!.detectedMs,
    ).toBe(1000);
  });
  test('counts duplicate and out-of-tolerance detections as false positives', () => {
    const result = matchBreakpoints([1000, 10000], [1000, 1001, 12001]);
    expect(result.matches).toHaveLength(1);
    expect(result.falsePositives).toEqual([1001, 12001]);
    expect(result.missedBreaks).toEqual([10000]);
    expect(matchBreakpoints([10000], [12000]).matches).toHaveLength(1);
  });
  test('empty predictions have undefined precision, not perfect precision', () => {
    expect(summarizeEvaluation(evaluationFixture())).toMatchObject({
      precision: null,
      recall: 0,
      missedBreaks: 1,
    });
  });
  test('escapes human-readable report content', () => {
    const html = renderEvaluation(evaluationFixture());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  test('cannot qualify synthetic data or real data with no matches', () => {
    const artifact = evaluationFixture();
    expect(() => qualificationDetails(artifact)).toThrow();
    artifact.kind = 'real';
    artifact.split = 'held-out';
    expect(() => qualificationDetails(artifact)).toThrow();
  });
  test('qualifies reviewed real held-out matches but refuses false positives', () => {
    const artifact = evaluationFixture();
    artifact.kind = 'real';
    artifact.split = 'held-out';
    artifact.episodes[0]!.result.candidates = [candidateFixture()];
    expect(qualificationDetails(artifact)).toMatchObject({
      configHash: 'test',
      detectorVersion: 'test',
    });
    artifact.episodes[0]!.result.candidates.push({
      ...candidateFixture(),
      timestampMs: 900000,
    });
    expect(() => qualificationDetails(artifact)).toThrow();
  });
});
