import { BreakDetectorConfigSchema } from '@tunarr/types/schemas';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import fixture from '../../testing/resources/break-analysis/mst3k-repeated-bumpers.json' with { type: 'json' };
import { evaluateBreaks, type ExtractedFeatures } from './BreakDetector.ts';
import { matchBreakpoints } from './BreakEvaluation.ts';
type EncodedFeatures = {
  startMs: number;
  audioDb: number[];
  video: { mean: number; blackRatio: number; pixels: string }[];
};
const config = BreakDetectorConfigSchema.parse({});
function decode(v: EncodedFeatures): ExtractedFeatures {
  return {
    ...v,
    video: v.video.map((f) => ({
      ...f,
      pixels: Buffer.from(f.pixels, 'base64'),
    })),
  };
}
function features(): ExtractedFeatures {
  // Unsampled gaps are non-candidate padding; every actual candidate has 15s
  // of real context on both sides, exceeding every detector context window.
  const result: ExtractedFeatures = {
    startMs: fixture.startMs,
    video: Array.from({ length: fixture.sampleCount }, () => ({
      mean: 0,
      blackRatio: 0,
      pixels: new Uint8Array(576),
    })),
    audioDb: Array(fixture.sampleCount).fill(-120),
  };
  const windows = JSON.parse(
    inflateSync(Buffer.from(fixture.windows, 'base64')).toString(),
  ) as EncodedFeatures[];
  for (const window of windows) {
    const offset = (window.startMs - fixture.startMs) / 100;
    const decoded = decode(window);
    result.video.splice(offset, decoded.video.length, ...decoded.video);
    result.audioDb.splice(offset, decoded.audioDb.length, ...decoded.audioDb);
  }
  return result;
}
function verify(value: ExtractedFeatures) {
  const candidates = evaluateBreaks(value, fixture.runtimeMs, config);
  const accepted = candidates.filter((c) => c.accepted);
  const comparison = matchBreakpoints(
    fixture.confirmedBreaksMs,
    accepted.map((c) => c.timestampMs),
    2000,
  );
  expect(comparison.missedBreaks, JSON.stringify(candidates)).toEqual([]);
  expect(accepted).toHaveLength(7);
  expect(
    accepted.every((c) => (c.evidence.repeatedBumperMatches ?? 0) >= 2),
  ).toBe(true);
  // 53:15 is unlabeled; it lacks the repeated bumper and remains diagnostic.
  expect(
    candidates.find((c) => Math.abs(c.timestampMs - 3195350) < 2000)?.accepted,
  ).toBe(false);
}
describe('MST3K repeated animated bumper', () => {
  test('accepts all seven confirmed breaks without accepting other candidates', () =>
    verify(features()));
  test('runtime cap can restrict results but never invents them', () => {
    const limited = BreakDetectorConfigSchema.parse({
      runtimeCaps: [{ belowMs: 14400001, maxBreaks: 6 }],
    });
    expect(
      evaluateBreaks(features(), fixture.runtimeMs, limited).filter(
        (c) => c.accepted,
      ),
    ).toHaveLength(6);
  });
  test.each(['no-silence', 'no-fade', 'excluded', 'static-logo', 'only-one'])(
    'recurrence cannot override %s',
    (kind) => {
      const f = features();
      const start = (912600 - fixture.startMs) / 100;
      const end = (913700 - fixture.startMs) / 100;
      if (kind === 'no-silence') f.audioDb.fill(-20, start, end);
      if (kind === 'no-fade')
        for (let i = start - 15; i < start; i++)
          f.video[i] = f.video[start - 20]!;
      if (kind === 'static-logo')
        for (let i = start - 50; i <= start - 10; i++)
          f.video[i] = f.video[start - 50]!;
      if (kind === 'only-one')
        for (let i = end + 150; i < f.video.length; i++)
          f.video[i] = { mean: 0, blackRatio: 0, pixels: new Uint8Array(576) };
      const c = evaluateBreaks(
        f,
        fixture.runtimeMs,
        config,
        kind === 'excluded' ? [{ startMs: 912000, endMs: 914000 }] : [],
      ).find((c) => Math.abs(c.timestampMs - 913150) < 2000)!;
      expect(c.accepted).toBe(false);
    },
  );
});
const fullPath = process.env['TUNARR_MST3K_FEATURES'];
test.skipIf(!fullPath)(
  'full production extraction agrees with portable windows',
  () => {
    const f = decode(
      JSON.parse(readFileSync(fullPath!, 'utf8')) as EncodedFeatures,
    );
    verify(f);
    expect(evaluateBreaks(f, fixture.runtimeMs, config)).toEqual(
      evaluateBreaks(features(), fixture.runtimeMs, config),
    );
  },
);
