import type { ChannelStreamMode } from '@tunarr/types';
import { isImageBasedSubtitle } from '../util.ts';

export type SubtitleDeliveryDecision = 'burn' | 'hls' | 'none';

type ChannelSubtitlePolicy = {
  subtitlesEnabled: boolean | null;
  subtitleDeliveryMethod?: 'burn' | 'hls' | null;
  subtitleUnsupportedFallback?: 'burn' | 'none' | null;
};

type SubtitleCandidate = {
  codec: string;
  type: 'embedded' | 'external';
  path?: string;
};

const SelectableHlsModes: ReadonlySet<ChannelStreamMode> = new Set([
  'hls',
  'hls_direct_v2',
]);

export function resolveSubtitleDelivery({
  channel,
  streamMode,
  subtitleStream,
}: {
  channel: ChannelSubtitlePolicy;
  streamMode: ChannelStreamMode;
  subtitleStream?: SubtitleCandidate;
}): SubtitleDeliveryDecision {
  if (!channel.subtitlesEnabled || !subtitleStream) {
    return 'none';
  }

  const deliveryMethod = channel.subtitleDeliveryMethod ?? 'burn';
  if (deliveryMethod === 'burn') {
    return 'burn';
  }

  if (isSelectableHlsSubtitle(streamMode, subtitleStream)) {
    return 'hls';
  }

  return channel.subtitleUnsupportedFallback ?? 'burn';
}

function isSelectableHlsSubtitle(
  streamMode: ChannelStreamMode,
  subtitleStream: SubtitleCandidate,
): boolean {
  return (
    SelectableHlsModes.has(streamMode) &&
    !isImageBasedSubtitle(subtitleStream.codec) &&
    !!subtitleStream.path
  );
}
