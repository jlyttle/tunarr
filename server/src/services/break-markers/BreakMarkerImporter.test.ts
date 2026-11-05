import type { BreakMarkerFile } from '@tunarr/types/api';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BreakMarkerDB } from '../../db/BreakMarkerDB.ts';
import { schema } from '../../db/schema/index.ts';
import {
  BreakMarkerImporter,
  matchMarkerEpisodes,
} from './BreakMarkerImporter.ts';

const episode = (
  relativePath: string,
  durationMs: number,
  offsets: number[] = [660_000],
): BreakMarkerFile['episodes'][number] => ({
  relativePath,
  durationMs,
  breaks: offsets.map((offsetMs) => ({ offsetMs, score: 1 })),
});

describe('matchMarkerEpisodes', () => {
  test('matches a path suffix with duration inside tolerance', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000)],
      [{ programId: 'p1', path: '/data/TV/X/a.mkv', durationMs: 1_002_000 }],
    );

    expect(result).toEqual({
      rows: [{ programId: 'p1', offsetsMs: [660_000] }],
      unmatched: [],
    });
  });

  test('rejects a duration off by 2001 ms', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000)],
      [{ programId: 'p1', path: '/data/TV/X/a.mkv', durationMs: 1_002_001 }],
    );

    expect(result).toEqual({ rows: [], unmatched: ['TV/X/a.mkv'] });
  });

  test('requires a slash boundary before the relative path', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000)],
      [
        {
          programId: 'p1',
          path: '/data/Kids TV/X/a.mkv',
          durationMs: 1_000_000,
        },
      ],
    );

    expect(result.rows).toEqual([]);
    expect(result.unmatched).toEqual(['TV/X/a.mkv']);
  });

  test('matches an NFD database path against an NFC relative path', () => {
    const nfc = 'TV/Café/a.mkv';
    const result = matchMarkerEpisodes(
      [episode(nfc, 1_000_000)],
      [
        {
          programId: 'p1',
          path: `/data/${nfc.normalize('NFD')}`,
          durationMs: 1_000_000,
        },
      ],
    );

    expect(result.rows).toEqual([{ programId: 'p1', offsetsMs: [660_000] }]);
  });

  test('gives every program with the same path a row', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000)],
      [
        { programId: 'p1', path: '/data/TV/X/a.mkv', durationMs: 1_000_000 },
        { programId: 'p2', path: '/other/TV/X/a.mkv', durationMs: 1_000_500 },
      ],
    );

    expect(result.rows.map((r) => r.programId)).toEqual(['p1', 'p2']);
  });

  test('writes an empty row for a matched episode without breaks', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000, [])],
      [{ programId: 'p1', path: '/data/TV/X/a.mkv', durationMs: 1_000_000 }],
    );

    expect(result.rows).toEqual([{ programId: 'p1', offsetsMs: [] }]);
  });
});

describe('BreakMarkerImporter', () => {
  let sqlite: Sqlite.Database;
  let markers: BreakMarkerDB;
  let importer: BreakMarkerImporter;

  const file: BreakMarkerFile = {
    schema: 1,
    detector: 'det',
    show: 'X',
    threshold: 0.5,
    episodes: [
      episode('TV/X/a.mkv', 1_000_000),
      episode('TV/X/missing.mkv', 1_000_000),
    ],
  };

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(
      readFileSync(
        new URL(
          '../../migration/db/sql/0058_break_markers.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    sqlite.exec(`
      create table program (uuid text primary key, type text not null);
      create table program_version (uuid text primary key, duration integer not null, program_id text not null);
      create table program_media_file (uuid text primary key, path text not null, program_version_id text not null);
      insert into program values ('p1', 'episode'), ('p2', 'movie');
      insert into program_version values ('v1', 1000000, 'p1'), ('v2', 1000000, 'p2');
      insert into program_media_file values ('f1', '/data/TV/X/a.mkv', 'v1'), ('f2', '/data/TV/X/a.mkv', 'v2');
    `);
    const db = drizzle(sqlite, { schema, casing: 'snake_case' });
    markers = new BreakMarkerDB(db);
    importer = new BreakMarkerImporter(db, markers);
  });
  afterEach(() => sqlite.close());

  test('imports episodes only and reports unmatched', async () => {
    const result = await importer.import(file);

    expect(result).toEqual({
      matched: 1,
      unmatched: ['TV/X/missing.mkv'],
      programs: 1,
    });
    expect(markers.offsetsFor(['p1', 'p2'])).toEqual(
      new Map([['p1', [660_000]]]),
    );
  });

  test('importing twice is idempotent', async () => {
    const first = await importer.import(file);
    const second = await importer.import(file);

    expect(second).toEqual(first);
    expect(markers.offsetsFor(['p1'])).toEqual(new Map([['p1', [660_000]]]));
  });
});
