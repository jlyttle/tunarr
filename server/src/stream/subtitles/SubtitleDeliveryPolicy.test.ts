import { describe, expect, it } from 'vitest';
import { resolveSubtitleDelivery } from './SubtitleDeliveryPolicy.ts';

describe('resolveSubtitleDelivery', () => {
  const baseChannel = {
    subtitlesEnabled: true,
    subtitleDeliveryMethod: 'hls',
    subtitleUnsupportedFallback: 'burn',
  } as const;

  it('uses HLS delivery for text subtitles with a resolved path on session HLS', () => {
    expect(
      resolveSubtitleDelivery({
        channel: baseChannel,
        streamMode: 'hls',
        subtitleStream: {
          codec: 'subrip',
          type: 'external',
          path: '/tmp/subtitles.srt',
        },
      }),
    ).toBe('hls');
  });

  it('falls back to burn-in when HLS delivery is requested for image subtitles', () => {
    expect(
      resolveSubtitleDelivery({
        channel: baseChannel,
        streamMode: 'hls',
        subtitleStream: {
          codec: 'hdmv_pgs_subtitle',
          type: 'embedded',
          path: undefined,
        },
      }),
    ).toBe('burn');
  });

  it('skips unsupported subtitles when the channel fallback is none', () => {
    expect(
      resolveSubtitleDelivery({
        channel: {
          ...baseChannel,
          subtitleUnsupportedFallback: 'none',
        },
        streamMode: 'hls',
        subtitleStream: {
          codec: 'hdmv_pgs_subtitle',
          type: 'embedded',
          path: undefined,
        },
      }),
    ).toBe('none');
  });
});
