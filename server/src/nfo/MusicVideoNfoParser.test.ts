import { readTestFile } from '../testing/util.ts';
import { MusicVideoNfoParser } from './MusicVideoNfoParser.ts';
import { nfoToMusicVideo } from '../services/scanner/LocalMusicVideoScanner.ts';

describe('MusicVideo NFO parser', () => {
  test('Kodi sample - ABBA', async () => {
    const contents = (await readTestFile('abba_music_video.nfo')).toString(
      'utf-8',
    );
    const result = await new MusicVideoNfoParser().parse(contents);
    expect(result.isSuccess()).toBe(true);

    const output = result.get().musicvideo;
    expect(output).toMatchObject({
      title: 'Dancing Queen',
      artist: ['ABBA'],
      album: 'Arrival',
      genre: ['Pop'],
      year: 1976,
    });
    expect(output.thumb).toHaveLength(2);
    expect(output.plot).toContain('Dancing Queen');
  });

  test('Simple NFO example with minimal data', async () => {
    const contents = (await readTestFile('music_video_2.nfo')).toString(
      'utf-8',
    );
    const result = await new MusicVideoNfoParser().parse(contents);
    expect(result.isSuccess()).toBe(true);

    const output = result.get().musicvideo;
    expect(output).toMatchObject({
      title: 'MORE',
      artist: ['Mark Osborne'],
      album: 'YouTube',
      premiered: '2013-03-03',
      year: 2013,
    });
    expect(output.plot).toContain('Academy Award');
    expect(output.genre).toBeUndefined();
    expect(output.thumb).toBeUndefined();
  });
});

describe('MusicVideo NFO studio and director', () => {
  const nfo = (body: string) =>
    `<musicvideo><title>T</title><artist>A</artist>${body}</musicvideo>`;

  test('single director and studio parse as arrays', async () => {
    const result = await new MusicVideoNfoParser().parse(
      nfo('<director>Spike Jonze</director><studio>4AD</studio>'),
    );
    const output = result.get().musicvideo;
    expect(output.director).toEqual(['Spike Jonze']);
    expect(output.studio).toEqual(['4AD']);
  });

  test('multiple studios are kept', async () => {
    const result = await new MusicVideoNfoParser().parse(
      nfo('<studio>4AD</studio><studio>Warner</studio>'),
    );
    expect(result.get().musicvideo.studio).toEqual(['4AD', 'Warner']);
  });
});

describe('MusicVideo NFO tolerance', () => {
  test('a studio with attributes does not fail the whole NFO', async () => {
    const result = await new MusicVideoNfoParser().parse(
      '<musicvideo><title>T</title><artist>A</artist><studio id="1">4AD</studio></musicvideo>',
    );
    expect(result.isSuccess()).toBe(true);
    const output = result.get().musicvideo;
    expect(output.studio).toBeUndefined();
    expect(output.title).toBe('T');
    expect(output.artist).toEqual(['A']);
  });
});

describe('nfoToMusicVideo', () => {
  const parse = async (body: string) =>
    (
      await new MusicVideoNfoParser().parse(
        `<musicvideo><title>T</title><artist>A</artist>${body}</musicvideo>`,
      )
    ).get().musicvideo;

  test('maps studios and directors', async () => {
    const metadata = nfoToMusicVideo(
      await parse('<director>Spike Jonze</director><studio>4AD</studio>'),
    );
    expect(metadata.studios).toEqual([{ name: '4AD' }]);
    expect(metadata.directors).toEqual([{ name: 'Spike Jonze' }]);
  });

  test('falls back to year tag without premiered', async () => {
    const metadata = nfoToMusicVideo(await parse('<year>1993</year>'));
    expect(metadata.year).toBe(1993);
  });
});
