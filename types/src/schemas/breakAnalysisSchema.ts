import { z } from 'zod/v4';

// All times are milliseconds relative to the beginning of the media file.
const time = z.number().int().nonnegative();
export const BreakIntervalSchema = z
  .object({ startMs: time, endMs: time })
  .refine((v) => v.endMs > v.startMs, 'Interval must have positive duration');

export const BreakDetectorConfigSchema = z
  .object({
    blackPixelThreshold: z.number().min(0).max(0.2).default(0.08),
    blackRatio: z.number().min(0.9).max(1).default(0.99),
    minBlackMs: time.min(100).default(250),
    maxBlackMs: time.min(100).default(2000),
    silenceDb: z.number().min(-100).max(-20).default(-45),
    minSilenceMs: time.min(100).default(200),
    contextMs: time.min(5000).max(30000).default(10000),
    visualDifference: z.number().min(0.05).max(1).default(0.18),
    minMotion: z.number().min(0).max(1).default(0.008),
    startExclusionMs: time.default(240000),
    // Retained for parsing historical results. New analyses use fixed durations.
    startExclusionFraction: z.number().min(0).max(0.5).default(0),
    endExclusionMs: time.default(240000),
    endExclusionFraction: z.number().min(0).max(0.5).default(0),
    chapterMarginMs: time.default(5000),
    clusterMs: time.min(100).default(3000),
    minimumSpacingMs: time.default(180000),
    runtimeCaps: z
      .array(z.object({ belowMs: time.positive(), maxBreaks: time.max(20) }))
      .min(1)
      .default([
        { belowMs: 600000, maxBreaks: 0 },
        { belowMs: 1200000, maxBreaks: 1 },
        { belowMs: 1800000, maxBreaks: 3 },
        { belowMs: 3600000, maxBreaks: 5 },
        { belowMs: 14400001, maxBreaks: 6 },
      ]),
  })
  .strict()
  .refine((c) => c.maxBlackMs >= c.minBlackMs, 'Invalid black duration range')
  .refine(
    (c) =>
      c.runtimeCaps.every((v, i, a) => i === 0 || v.belowMs > a[i - 1].belowMs),
    'Runtime caps must be ordered',
  );
export type BreakDetectorConfig = z.infer<typeof BreakDetectorConfigSchema>;

export function normalizeBreakDetectorConfig(
  config: BreakDetectorConfig,
): BreakDetectorConfig {
  return {
    ...config,
    startExclusionMs: Math.max(240000, config.startExclusionMs),
    endExclusionMs: Math.max(240000, config.endExclusionMs),
    startExclusionFraction: 0,
    endExclusionFraction: 0,
  };
}

export const BreakCandidateSchema = z.object({
  timestampMs: time,
  confidence: z.enum(['low', 'medium', 'high']),
  accepted: z.boolean(),
  reasons: z.array(z.string()),
  evidence: z.object({
    blackStartMs: time,
    blackEndMs: time,
    silenceOverlapMs: time,
    fade: z.boolean(),
    visualDifference: z.number(),
    motionBefore: z.number(),
    motionAfter: z.number(),
    audioContext: z.boolean(),
    completeContext: z.boolean(),
  }),
});
export type BreakCandidate = z.infer<typeof BreakCandidateSchema>;

export const BreakAnalysisResultSchema = z.object({
  id: z.string(),
  programId: z.string().optional(),
  programVersionId: z.string().optional(),
  mediaFileId: z.string().optional(),
  seriesId: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'skipped', 'interrupted']),
  createdAt: time,
  finishedAt: time.optional(),
  detectorVersion: z.string(),
  configHash: z.string(),
  config: BreakDetectorConfigSchema,
  sourceFingerprint: z.string(),
  runtimeMs: time.positive(),
  scanWindow: z
    .object({ startMs: time, endMs: time })
    .refine((v) => v.endMs >= v.startMs, 'Invalid scan window')
    .optional(),
  videoStreamIndex: time.optional(),
  audioStreamIndex: time.optional(),
  candidates: z.array(BreakCandidateSchema),
  usableBreaks: z.array(BreakCandidateSchema),
  qualified: z.boolean(),
  stale: z.boolean().default(false),
  error: z.string().optional(),
});
export type BreakAnalysisResult = z.infer<typeof BreakAnalysisResultSchema>;

export const BreakAnalysisRequestSchema = z
  .object({
    programIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    seriesId: z.string().uuid().optional(),
    libraryId: z.string().uuid().optional(),
    allEpisodes: z.literal(true).optional(),
    force: z.boolean().default(false),
    config: BreakDetectorConfigSchema.transform(
      normalizeBreakDetectorConfig,
    ).default(() => BreakDetectorConfigSchema.parse({})),
    videoStreamIndex: time.optional(),
    audioStreamIndex: time.optional(),
    timeoutMs: time.min(1000).max(86400000).default(14400000),
    threads: z.number().int().min(1).max(4).default(1),
  })
  .strict()
  .refine(
    (r) =>
      [r.programIds, r.seriesId, r.libraryId, r.allEpisodes].filter(Boolean)
        .length === 1,
    'Select exactly one of programIds, seriesId, libraryId or allEpisodes',
  );
export type BreakAnalysisRequest = z.infer<typeof BreakAnalysisRequestSchema>;

export const BreakEvaluationManifestSchema = z
  .object({
    datasetId: z.string().min(1),
    kind: z.enum(['synthetic', 'real']),
    split: z.enum(['development', 'held-out']),
    toleranceMs: time.default(2000),
    episodes: z
      .array(
        z.object({
          id: z.string().min(1),
          path: z.string().min(1),
          runtimeMs: time.positive().max(14400000),
          expectedBreaks: z.array(time),
          exclusions: z.array(BreakIntervalSchema).default([]),
          labels: z.array(z.string()).default([]),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine(
    (m) => new Set(m.episodes.map((e) => e.id)).size === m.episodes.length,
    'Duplicate episode IDs',
  )
  .refine(
    (m) =>
      m.episodes.every(
        (e) =>
          e.expectedBreaks.every((t) => t < e.runtimeMs) &&
          new Set(e.expectedBreaks).size === e.expectedBreaks.length &&
          e.exclusions.every((x) => x.endMs <= e.runtimeMs),
      ),
    'Invalid episode labels',
  );
