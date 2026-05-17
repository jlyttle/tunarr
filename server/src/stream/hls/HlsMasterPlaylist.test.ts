import { describe, expect, it } from 'vitest';
import { createHlsMasterPlaylist } from './HlsMasterPlaylist.ts';

describe('createHlsMasterPlaylist', () => {
  it('advertises a subtitle rendition and the existing video playlist', () => {
    const playlist = createHlsMasterPlaylist({
      videoPlaylistUri: '/stream/channels/channel-id/hls/video.m3u8',
      subtitleRenditions: [
        {
          groupId: 'subs',
          language: 'eng',
          name: 'English',
          playlistUri: '/stream/channels/channel-id/hls/subtitles/eng.m3u8',
          default: true,
        },
      ],
    });

    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="eng",URI="/stream/channels/channel-id/hls/subtitles/eng.m3u8"',
    );
    expect(playlist).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,SUBTITLES="subs"',
    );
    expect(playlist).toContain('/stream/channels/channel-id/hls/video.m3u8');
  });
});
