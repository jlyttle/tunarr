import { describe, expect, test } from 'vitest';
import { buildLabelSpec } from './musicVideoLabel.ts';
import type { MusicVideoMetadata } from './musicVideoMetadata.ts';

const full: MusicVideoMetadata = {
  artist: 'The Breeders',
  title: 'Cannonball',
  album: 'Last Splash',
  label: '4AD',
  tags: [],
};

describe('buildLabelSpec', () => {
  test('builds lines and start/end windows', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 0, videoDurationSec: 240 }),
    ).toEqual({
      lines: ['The Breeders', '"Cannonball"', 'Last Splash', '4AD'],
      windows: [
        [5, 13],
        [220, 240],
      ],
    });
  });

  test('includes director and skips empty lines', () => {
    const spec = buildLabelSpec(
      { artist: 'A', title: 'T', album: '', director: 'D', tags: [] },
      { streamStartSec: 0, videoDurationSec: 240 },
    );
    expect(spec?.lines).toEqual(['A', '"T"', 'D']);
  });

  test('shifts windows for a mid-video start and drops past ones', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 180, videoDurationSec: 240 }),
    ).toMatchObject({ windows: [[40, 60]] });
  });

  test('clips windows at zero', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 10, videoDurationSec: 240 }),
    ).toMatchObject({
      windows: [
        [0, 3],
        [210, 230],
      ],
    });
  });

  test('short video keeps only the start window', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 0, videoDurationSec: 25 }),
    ).toMatchObject({ windows: [[5, 13]] });
  });

  test('clips the start window to a very short video', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 0, videoDurationSec: 10 }),
    ).toMatchObject({ windows: [[5, 10]] });
  });

  test('returns null when nothing remains', () => {
    expect(
      buildLabelSpec(full, { streamStartSec: 0, videoDurationSec: 4 }),
    ).toBeNull();
    expect(
      buildLabelSpec(full, { streamStartSec: 100, videoDurationSec: 25 }),
    ).toBeNull();
  });

  test('returns null without artist, with label:builtin, or null meta', () => {
    const opts = { streamStartSec: 0, videoDurationSec: 240 };
    expect(buildLabelSpec({ ...full, artist: undefined }, opts)).toBeNull();
    expect(
      buildLabelSpec({ ...full, tags: ['label:builtin'] }, opts),
    ).toBeNull();
    expect(buildLabelSpec(null, opts)).toBeNull();
  });
});

describe('buildLabelSpec whitespace', () => {
  const timing = { streamStartSec: 0, videoDurationSec: 240 };

  test('a whitespace-only artist builds no spec', () => {
    expect(buildLabelSpec({ ...full, artist: '  ' }, timing)).toBeNull();
  });

  test('drops lines that are blank after trimming', () => {
    expect(buildLabelSpec({ ...full, album: '\t' }, timing)?.lines).toEqual([
      'The Breeders',
      '"Cannonball"',
      '4AD',
    ]);
  });

  test('collapses embedded line breaks and tabs into single spaces', () => {
    expect(
      buildLabelSpec(
        { ...full, artist: ' The\r\nBreeders ', title: 'Cannon\nball\t' },
        timing,
      )?.lines.slice(0, 2),
    ).toEqual(['The Breeders', '"Cannon ball"']);
  });

  test('omits the title line when the title is blank', () => {
    expect(buildLabelSpec({ ...full, title: ' \n ' }, timing)?.lines).toEqual([
      'The Breeders',
      'Last Splash',
      '4AD',
    ]);
  });
});
