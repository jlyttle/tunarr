import { BreakDetectorConfigSchema } from '@tunarr/types/schemas';
import { describe, expect, test } from 'vitest';
import { evaluateBreaks, type ExtractedFeatures } from './BreakDetector.ts';

const config = BreakDetectorConfigSchema.parse({});
function episode(events = [450000], runtime = 1440000): ExtractedFeatures {
  const video = Array.from({ length: runtime / 100 }, (_, i) => {
    const scene = events.filter((t) => i * 100 > t).length % 2;
    const mean = (scene ? 0.8 : 0.3) + (i % 2 ? 0.03 : -0.03);
    return {
      mean,
      blackRatio: 0,
      pixels: new Uint8Array(8).fill(Math.round(mean * 255)),
    };
  });
  const audioDb = video.map(() => -20);
  for (const time of events) {
    const start = time / 100;
    const previousMean = video[start - 10]!.mean;
    for (let i = 0; i < 8; i++)
      video[start - 8 + i] = {
        mean: (previousMean * (8 - i)) / 8,
        blackRatio: 0,
        pixels: new Uint8Array(8).fill(25),
      };
    for (let i = start; i < start + 6; i++) {
      video[i] = { mean: 0, blackRatio: 1, pixels: new Uint8Array(8) };
      audioDb[i] = -120;
    }
  }
  return { video, audioDb };
}

describe('conservative episode break rules', () => {
  test('accepts a faded silent boundary with sustained different scenes', () => {
    const candidates = evaluateBreaks(episode(), 1440000, config);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      timestampMs: 450300,
      confidence: 'high',
      accepted: true,
      reasons: [],
    });
  });
  test.each([
    'mouth',
    'natural-silence',
    'continuing-fade',
    'static-title',
    'persistent-darkness',
    'dramatic-cut',
  ])('rejects %s', (kind) => {
    const features = episode();
    if (kind === 'mouth' || kind === 'dramatic-cut') {
      for (let i = 4492; i < 4500; i++)
        features.video[i] = features.video[4490]!;
    }
    if (kind === 'natural-silence') features.audioDb.fill(-120);
    if (kind === 'continuing-fade') {
      for (let i = 4506; i < features.video.length; i++)
        features.video[i] = features.video[4400 + (i % 2)]!;
    }
    if (kind === 'static-title') {
      for (let i = 4506; i < features.video.length; i++)
        features.video[i] = features.video[4600]!;
    }
    if (kind === 'persistent-darkness') {
      for (let i = 4500; i < 4600; i++)
        features.video[i] = features.video[4500]!;
    }
    expect(
      evaluateBreaks(features, 1440000, config).every((c) => !c.accepted),
    ).toBe(true);
  });
  test('black plus low audio without a fade is diagnostic only', () => {
    const features = episode();
    for (let i = 4492; i < 4500; i++) features.video[i] = features.video[4400]!;
    expect(evaluateBreaks(features, 1440000, config)[0]!.reasons).toContain(
      'no-fade',
    );
  });
  test.each([60000, 120000, 1350000])(
    'excludes intro, cold open, theme and closing regions at %s',
    (time) => {
      expect(
        evaluateBreaks(episode([time]), 1440000, config)[0]!.reasons,
      ).toContain('excluded-region');
    },
  );
  test('excludes known chapter/cartoon-segment boundaries', () => {
    expect(
      evaluateBreaks(episode(), 1440000, config, [
        { startMs: 445000, endMs: 455000 },
      ])[0]!.accepted,
    ).toBe(false);
  });
  test('caps a 24 minute episode at three without inventing detections', () => {
    expect(
      evaluateBreaks(
        episode([200000, 450000, 700000, 950000]),
        1440000,
        config,
      ).filter((c) => c.accepted),
    ).toHaveLength(3);
    expect(evaluateBreaks(episode([]), 1440000, config)).toEqual([]);
    expect(
      evaluateBreaks(episode(), 1440000, config).filter((c) => c.accepted),
    ).toHaveLength(1);
  });
  test('collapses nearby hypotheses without averaging timestamps', () => {
    const candidates = evaluateBreaks(
      episode([450000, 452000]),
      1440000,
      config,
    );
    expect(candidates).toHaveLength(1);
    expect([450300, 452300]).toContain(candidates[0]!.timestampMs);
  });
  test('suppresses accepted events within minimum spacing', () => {
    const candidates = evaluateBreaks(
      episode([450000, 550000]),
      1440000,
      config,
    );
    expect(candidates.filter((c) => c.accepted)).toHaveLength(1);
    expect(candidates.some((c) => c.reasons.includes('minimum-spacing'))).toBe(
      true,
    );
  });
  test('validates configuration and ordered runtime caps', () => {
    expect(() =>
      BreakDetectorConfigSchema.parse({ maxBlackMs: 100 }),
    ).toThrow();
    expect(() =>
      BreakDetectorConfigSchema.parse({
        runtimeCaps: [
          { belowMs: 20, maxBreaks: 1 },
          { belowMs: 10, maxBreaks: 2 },
        ],
      }),
    ).toThrow();
  });
});
