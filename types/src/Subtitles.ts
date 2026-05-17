import type { z } from 'zod/v4';
import type {
  SubtitleDeliveryMethodSchema,
  SubtitleFilterSchema,
  SubtitlePreference,
  SubtitleUnsupportedFallbackSchema,
} from './schemas/subtitleSchema.js';

export type SubtitlePreference = z.infer<typeof SubtitlePreference>;

export type SubtitleFilter = z.infer<typeof SubtitleFilterSchema>;

export type SubtitleDeliveryMethod = z.infer<
  typeof SubtitleDeliveryMethodSchema
>;

export type SubtitleUnsupportedFallback = z.infer<
  typeof SubtitleUnsupportedFallbackSchema
>;
