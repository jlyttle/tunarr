import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChildProcessHelper } from '../util/ChildProcessHelper.ts';
import { FileStreamSource, HttpStreamSource } from '../stream/types.ts';
import { FfprobeStreamDetails } from '../stream/FfprobeStreamDetails.ts';
import { FfmpegInfo } from './ffmpegInfo.ts';

const video = (field_order?: string, index = 0) => ({
  index,
  codec_type: 'video',
  codec_name: 'mpeg2video',
  width: 720,
  height: 480,
  coded_width: 720,
  coded_height: 480,
  field_order,
  r_frame_rate: '30000/1001',
});

afterEach(() => vi.restoreAllMocks());

describe('interlace metadata probing', () => {
  test.each([
    ['tt', 'interlaced'],
    ['bb', 'interlaced'],
    ['tb', 'interlaced'],
    ['bt', 'interlaced'],
    ['progressive', 'progressive'],
    ['unknown', 'unknown'],
    [undefined, 'unknown'],
    ['invalid', 'unknown'],
  ])(
    'maps %s to %s in background probes and stream details',
    async (order, expected) => {
      vi.spyOn(ChildProcessHelper.prototype, 'getStdout').mockResolvedValue(
        JSON.stringify({
          streams: [video(order)],
          format: {
            duration: '1426.432',
            nb_streams: 1,
            format_name: 'matroska',
            size: '1000',
            bit_rate: '1000',
          },
          chapters: [],
        }),
      );
      const info = new FfmpegInfo('ffmpeg', 'ffprobe');
      expect(
        await info.probeScanKind(new FileStreamSource('/episode.mkv'), 0),
      ).toBe(expected);
      const details = await new FfprobeStreamDetails(info).getStream({
        path: '/episode.mkv',
      });
      expect(details.get().streamDetails.videoDetails?.[0]?.scanType).toBe(
        expected,
      );
    },
  );

  test('matches the requested index and rejects attached pictures', async () => {
    const probe = vi
      .spyOn(ChildProcessHelper.prototype, 'getStdout')
      .mockResolvedValue(
        JSON.stringify({
          streams: [
            video('progressive', 0),
            video('tt', 2),
            { ...video('tt', 3), disposition: { attached_pic: 1 } },
          ],
        }),
      );
    const info = new FfmpegInfo('ffmpeg', 'ffprobe');
    expect(
      await info.probeScanKind(new FileStreamSource('/episode.mkv'), 2),
    ).toBe('interlaced');
    expect(
      await info.probeScanKind(new FileStreamSource('/episode.mkv'), 3),
    ).toBe('unknown');
    expect(
      await info.probeScanKind(new FileStreamSource('/episode.mkv'), 9),
    ).toBe('unknown');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test('passes authentication headers with a bounded timeout and suppresses command logging', async () => {
    const probe = vi
      .spyOn(ChildProcessHelper.prototype, 'getStdout')
      .mockResolvedValue('{"streams":[]}');
    const source = new HttpStreamSource('http://media/stream', {
      'X-Emby-Token': 'secret',
    });
    await new FfmpegInfo('ffmpeg', 'ffprobe').probeScanKind(source, 0);
    expect(probe).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining([
        '-headers',
        'X-Emby-Token: secret\r\n',
        source.path,
      ]),
      { timeout: 30_000, swallowError: false, logCommand: false },
    );
  });

  test('propagates probe failures for the repair service to handle', async () => {
    vi.spyOn(ChildProcessHelper.prototype, 'getStdout').mockRejectedValue(
      new Error('timed out'),
    );
    await expect(
      new FfmpegInfo('ffmpeg', 'ffprobe').probeScanKind(
        new FileStreamSource('/episode.mkv'),
        0,
      ),
    ).rejects.toThrow('timed out');
  });
});
