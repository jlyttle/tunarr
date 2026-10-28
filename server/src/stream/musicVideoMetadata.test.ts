import type { ProgramOrmWithExternalIds } from '@/db/schema/derivedTypes.js';
import { describe, expect, it } from 'vitest';
import { musicVideoMetadata, parseGainTag } from './musicVideoMetadata.ts';

function program(
  overrides: Record<string, unknown> = {},
): ProgramOrmWithExternalIds {
  return {
    type: 'music_video',
    title: 'Hungry Like the Wolf',
    artistName: 'Duran Duran, Nick Rhodes',
    albumName: 'Rio',
    externalIds: [],
    studios: [{ studio: { name: 'EMI' } }, { studio: { name: 'Capitol' } }],
    credits: [
      { type: 'cast', name: 'Simon Le Bon' },
      { type: 'director', name: 'Russell Mulcahy' },
      { type: 'director', name: 'Someone Else' },
    ],
    tags: [{ tag: { tag: 'new wave' } }, { tag: { tag: '80s' } }],
    ...overrides,
  } as unknown as ProgramOrmWithExternalIds;
}

describe('musicVideoMetadata', () => {
  it('returns null for non music videos', () => {
    expect(musicVideoMetadata(program({ type: 'movie' }))).toBeNull();
  });

  it('maps the program to display metadata', () => {
    expect(musicVideoMetadata(program())).toEqual({
      artist: 'Duran Duran, Nick Rhodes',
      title: 'Hungry Like the Wolf',
      album: 'Rio',
      label: 'EMI',
      director: 'Russell Mulcahy',
      tags: ['new wave', '80s'],
    });
  });

  it('omits missing and empty fields', () => {
    const result = musicVideoMetadata(
      program({
        artistName: '',
        albumName: null,
        studios: [],
        credits: [],
        tags: undefined,
      }),
    );
    expect(result).toEqual({ title: 'Hungry Like the Wolf', tags: [] });
    expect(result).not.toHaveProperty('artist');
  });
});

describe('parseGainTag', () => {
  it('parses signed decimal gains', () => {
    expect(parseGainTag(['gain:-2.6'])).toBe(-2.6);
    expect(parseGainTag(['gain:+12.0'])).toBe(12);
  });

  it('returns the first matching tag', () => {
    expect(parseGainTag(['80s', 'gain:1.5', 'gain:2'])).toBe(1.5);
  });

  it('returns null when no tag is a valid gain', () => {
    expect(parseGainTag(['gain:abc'])).toBeNull();
    expect(parseGainTag(['new wave'])).toBeNull();
    expect(parseGainTag([])).toBeNull();
  });
});
