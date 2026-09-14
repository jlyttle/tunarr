import { BreakDetectorConfigSchema } from '@tunarr/types/schemas';
import { inflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import fixture from '../../testing/resources/break-analysis/pod-people-bumpers.json' with { type: 'json' };
import { evaluateBreaks, type ExtractedFeatures } from './BreakDetector.ts';
const config = BreakDetectorConfigSchema.parse({});
function features(): ExtractedFeatures {
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
  ) as {
    startMs: number;
    audioDb: number[];
    video: { mean: number; blackRatio: number; pixels: string }[];
  }[];
  for (const w of windows) {
    const offset = (w.startMs - fixture.startMs) / 100;
    result.video.splice(
      offset,
      w.video.length,
      ...w.video.map((v) => ({
        ...v,
        pixels: Buffer.from(v.pixels, 'base64'),
      })),
    );
    result.audioDb.splice(offset, w.audioDb.length, ...w.audioDb);
  }
  return result;
}
test('short silent bumper pause captures the confirmed Pod People break', () => {
  const candidates = evaluateBreaks(features(), fixture.runtimeMs, config);
  const target = candidates.find(
    (c) => Math.abs(c.timestampMs - 1598000) < 2000,
  )!;
  expect(target, JSON.stringify(candidates)).toMatchObject({
    accepted: true,
    confidence: 'high',
    reasons: [],
    evidence: { repeatedBumperMatches: 2 },
  });
  expect(fixture.confirmedBreaksMs).toEqual([1598000]);
  // Other matching bumpers are review candidates, not confirmed ground truth.
  expect(
    candidates.filter((c) => c.accepted).map((c) => c.timestampMs),
  ).toEqual([1597900, ...fixture.reviewPointsMs]);
});
test.each([
  'insufficient-silence',
  'partial-silence',
  'abrupt-cut',
  'only-two-occurrences',
  'explicit-exclusion',
])('short bumper still rejects %s', (kind) => {
  const f = features();
  const start = (1597600 - fixture.startMs) / 100;
  if (kind === 'insufficient-silence') {
    f.audioDb.fill(-20, start, start + 5);
    f.audioDb[start] = -100;
  }
  if (kind === 'partial-silence') {
    f.audioDb.fill(-20, start, start + 5);
    f.audioDb.fill(-100, start, start + 2);
  }
  if (kind === 'abrupt-cut')
    for (let i = start - 15; i < start; i++) f.video[i] = f.video[start - 20]!;
  if (kind === 'only-two-occurrences')
    for (let i = (4473000 - fixture.startMs) / 100; i < f.video.length; i++)
      f.video[i] = { mean: 0, blackRatio: 0, pixels: new Uint8Array(576) };
  const target = evaluateBreaks(
    f,
    fixture.runtimeMs,
    config,
    kind === 'explicit-exclusion' ? [{ startMs: 1597000, endMs: 1599000 }] : [],
  ).find((c) => Math.abs(c.timestampMs - 1598000) < 2000)!;
  expect(target.accepted).toBe(false);
});
