export type HlsSubtitleRendition = {
  groupId: string;
  language: string;
  name: string;
  playlistUri: string;
  default: boolean;
};

export function createHlsMasterPlaylist({
  videoPlaylistUri,
  subtitleRenditions,
}: {
  videoPlaylistUri: string;
  subtitleRenditions: HlsSubtitleRendition[];
}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const subtitleGroup = subtitleRenditions[0]?.groupId;

  for (const rendition of subtitleRenditions) {
    lines.push(
      [
        '#EXT-X-MEDIA:TYPE=SUBTITLES',
        `GROUP-ID="${escapeAttribute(rendition.groupId)}"`,
        `NAME="${escapeAttribute(rendition.name)}"`,
        `DEFAULT=${rendition.default ? 'YES' : 'NO'}`,
        'AUTOSELECT=YES',
        `LANGUAGE="${escapeAttribute(rendition.language)}"`,
        `URI="${escapeAttribute(rendition.playlistUri)}"`,
      ].join(','),
    );
  }

  lines.push(
    subtitleGroup
      ? `#EXT-X-STREAM-INF:BANDWIDTH=8000000,SUBTITLES="${escapeAttribute(subtitleGroup)}"`
      : '#EXT-X-STREAM-INF:BANDWIDTH=8000000',
    videoPlaylistUri,
    '',
  );

  return lines.join('\n');
}

function escapeAttribute(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
