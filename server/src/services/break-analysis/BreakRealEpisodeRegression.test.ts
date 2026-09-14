import { BreakAnalysisResultSchema } from '@tunarr/types/schemas';
import { describe, expect, test } from 'vitest';
import fixture from '../../testing/resources/break-analysis/extended-black-1503.json' with { type: 'json' };
import { matchBreakpoints } from './BreakEvaluation.ts';
import { breakScanWindow } from './BreakDetector.ts';

// This is archived v1 output, not a substitute for decoding the original media.
// Only manually confirmed points are labeled; other candidates remain unknown.
const analysis = BreakAnalysisResultSchema.parse(fixture.analysis);

describe('real episode: extended black transitions near 9:24 and 15:03', () => {
  test('the four-minute scan policy retains both confirmed breaks and excludes opening review points', () => {
    const window = breakScanWindow(analysis.runtimeMs, analysis.config);
    expect(window).toEqual({ startMs: 240000, endMs: 1035200 });
    for (const timestamp of fixture.confirmedBreaksMs) {
      expect(timestamp).toBeGreaterThan(window.startMs);
      expect(timestamp).toBeLessThan(window.endMs);
    }
    expect(
      fixture.unverifiedReviewPointsMs.every(
        (timestamp) => timestamp < window.startMs,
      ),
    ).toBe(true);
  });
  test('candidate extraction captured both manually confirmed transitions within tolerance', () => {
    const comparison = matchBreakpoints(
      fixture.confirmedBreaksMs,
      analysis.candidates.map((candidate) => candidate.timestampMs),
      fixture.toleranceMs,
    );
    expect(comparison.missedBreaks).toEqual([]);
    expect(comparison.matches).toMatchObject([
      { expectedMs: 564000, detectedMs: 564100, errorMs: 100 },
      { expectedMs: 903000, detectedMs: 903550, errorMs: 550 },
    ]);
    // Do not interpret other candidates as false positives: labeling is partial.
  });

  test('the archived v1 acceptance result records both known missed breaks', () => {
    const comparison = matchBreakpoints(
      fixture.confirmedBreaksMs,
      analysis.candidates
        .filter((candidate) => candidate.accepted)
        .map((candidate) => candidate.timestampMs),
      fixture.toleranceMs,
    );
    expect(comparison.missedBreaks).toEqual(fixture.confirmedBreaksMs);
    for (const expected of [
      { timestampMs: 564100, blackDurationMs: 2900, silenceOverlapMs: 1600 },
      { timestampMs: 903550, blackDurationMs: 3500, silenceOverlapMs: 1100 },
    ]) {
      const candidate = analysis.candidates.find(
        (c) => c.timestampMs === expected.timestampMs,
      )!;
      expect(candidate.reasons).toEqual([
        'black-duration',
        'no-fade',
        'scene-continuity',
      ]);
      expect(
        candidate.evidence.blackEndMs - candidate.evidence.blackStartMs,
      ).toBe(expected.blackDurationMs);
      expect(candidate.evidence.silenceOverlapMs).toBe(
        expected.silenceOverlapMs,
      );
    }
  });

  test('unverified review points are not promoted to ground truth', () => {
    expect(fixture.labelCoverage).toBe('partial');
    expect(fixture.confirmedBreaksMs).toEqual([564000, 903000]);
    expect(fixture.unverifiedReviewPointsMs).toEqual([89100, 150050]);
    for (const point of fixture.unverifiedReviewPointsMs) {
      expect(analysis.candidates.some((c) => c.timestampMs === point)).toBe(
        true,
      );
      expect(fixture.confirmedBreaksMs).not.toContain(point);
    }
  });
});
