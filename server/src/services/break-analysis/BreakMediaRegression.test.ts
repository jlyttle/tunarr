import { BreakDetectorConfigSchema } from '@tunarr/types/schemas';
import { FileStreamSource } from '../../stream/types.ts';
import { BreakFeatureExtractor } from './BreakFeatureExtractor.ts';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import fixture from '../../testing/resources/break-analysis/real-transition-features.json' with { type: 'json' };
import { evaluateBreaks, type ExtractedFeatures } from './BreakDetector.ts';
const config = BreakDetectorConfigSchema.parse({});
function decode(encoded: string): ExtractedFeatures {
  const value = JSON.parse(
    inflateSync(Buffer.from(encoded, 'base64')).toString(),
  ) as {
    startMs: number;
    audioDb: number[];
    video: { mean: number; blackRatio: number; pixels: string }[];
  };
  return {
    ...value,
    video: value.video.map((v) => ({
      ...v,
      pixels: Buffer.from(v.pixels, 'base64'),
    })),
  };
}
describe('media-derived transition regression', () => {
  for (const item of fixture.cases) {
    test(`candidate ${item.candidateMs}`, () => {
      const candidates = evaluateBreaks(
        decode(item.features),
        fixture.runtimeMs,
        config,
      );
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      if (item.expectedMs !== null) {
        expect(candidate, JSON.stringify(candidate)).toMatchObject({
          accepted: true,
          confidence: 'high',
          reasons: [],
          evidence: { fade: true },
        });
        expect(
          Math.abs(candidate.timestampMs - item.expectedMs),
        ).toBeLessThanOrEqual(2000);
      } else {
        // Unlabeled candidates remain diagnostic; this is not a ground-truth negative label.
        expect(candidate.accepted).toBe(false);
      }
    });
  }
  const positive = fixture.cases.find((c) => c.expectedMs !== null)!;
  test.each([
    'abrupt-black',
    'continuing-scene',
    'quiet-surroundings',
    'short-silence',
    'near-black-object',
    'chapter',
  ])('rejects extended transition with %s', (kind) => {
    const features = decode(positive.features);
    const start = (562300 - features.startMs!) / 100;
    const end = (565200 - features.startMs!) / 100;
    if (kind === 'abrupt-black')
      for (let i = start - 15; i < start; i++)
        features.video[i] = features.video[start - 20]!;
    if (kind === 'continuing-scene')
      for (let i = end; i < features.video.length; i++)
        features.video[i] =
          features.video[start - (i - end) - 1] ?? features.video[0]!;
    if (kind === 'quiet-surroundings') features.audioDb.fill(-100);
    if (kind === 'short-silence') {
      features.audioDb.fill(-20);
      features.audioDb.fill(-100, start + 10, start + 15);
    }
    if (kind === 'near-black-object')
      for (let i = start; i < end; i++)
        features.video[i] = { ...features.video[i]!, mean: 0.02 };
    const candidates = evaluateBreaks(
      features,
      fixture.runtimeMs,
      config,
      kind === 'chapter' ? [{ startMs: 562000, endMs: 566000 }] : [],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.accepted).toBe(false);
  });
});

// Optional end-to-end replay; ordinary CI uses the portable extracted samples.
const media = process.env['TUNARR_BREAK_REGRESSION_MEDIA'];
test.skipIf(!media)(
  'full real episode accepts only the two confirmed transitions',
  async () => {
    const { features } = await new BreakFeatureExtractor(
      'ffmpeg',
      'ffprobe',
    ).extract(new FileStreamSource(media!), fixture.runtimeMs, config, {
      timeoutMs: 120000,
      threads: 1,
    });
    const accepted = evaluateBreaks(features, fixture.runtimeMs, config).filter(
      (c) => c.accepted,
    );
    expect(accepted).toHaveLength(2);
    expect(Math.abs(accepted[0]!.timestampMs - 564000)).toBeLessThanOrEqual(
      2000,
    );
    expect(Math.abs(accepted[1]!.timestampMs - 903000)).toBeLessThanOrEqual(
      2000,
    );
  },
  130000,
);
