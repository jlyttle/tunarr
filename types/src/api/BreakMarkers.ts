import { z } from 'zod/v4';

export const BreakMarkerFileSchema = z.object({
  schema: z.literal(1),
  detector: z.string(),
  show: z.string(),
  threshold: z.number(),
  episodes: z.array(
    z.object({
      relativePath: z.string(),
      durationMs: z.number(),
      breaks: z.array(
        z.object({
          offsetMs: z.number().int().nonnegative(),
          score: z.number(),
        }),
      ),
    }),
  ),
});

export type BreakMarkerFile = z.infer<typeof BreakMarkerFileSchema>;

export const BreakMarkerImportResultSchema = z.object({
  matched: z.number().int(),
  unmatched: z.array(z.string()),
  programs: z.number().int(),
});

export type BreakMarkerImportResult = z.infer<
  typeof BreakMarkerImportResultSchema
>;
