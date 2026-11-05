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

  test('emits one row per program when it has several matching files', () => {
    const result = matchMarkerEpisodes(
      [episode('TV/X/a.mkv', 1_000_000)],
      [
        { programId: 'p1', path: '/data/TV/X/a.mkv', durationMs: 1_000_000 },
        { programId: 'p1', path: '/backup/TV/X/a.mkv', durationMs: 1_000_000 },
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

  function addEpisode(id: string, path: string) {
    sqlite.prepare('insert into program values (?, ?)').run(id, 'episode');
    sqlite
      .prepare('insert into program_version values (?, ?, ?)')
      .run(`v-${id}`, 1_000_000, id);
    sqlite
      .prepare('insert into program_media_file values (?, ?, ?)')
      .run(`f-${id}`, path, `v-${id}`);
  }

  const fileFor = (...relativePaths: string[]): BreakMarkerFile => ({
    ...file,
    episodes: relativePaths.map((p) => episode(p, 1_000_000)),
  });

  test('finds an NFD database path from an NFC marker name', async () => {
    const name = 'TV/Caf\u00e9/a.mkv';
    addEpisode('n1', `/data/${name.normalize('NFD')}`);

    const result = await importer.import(fileFor(name.normalize('NFC')));

    expect(result.unmatched).toEqual([]);
    expect(markers.offsetsFor(['n1']).has('n1')).toBe(true);
  });

  test('finds an NFC database path from an NFD marker name', async () => {
    const name = 'TV/Caf\u00e9/a.mkv';
    addEpisode('n2', `/data/${name.normalize('NFC')}`);

    const result = await importer.import(fileFor(name.normalize('NFD')));

    expect(result.unmatched).toEqual([]);
    expect(markers.offsetsFor(['n2']).has('n2')).toBe(true);
  });

  test('matches names containing an underscore', async () => {
    addEpisode('u1', '/data/TV/X/a_b.mkv');

    const result = await importer.import(fileFor('TV/X/a_b.mkv'));

    expect(result.matched).toBe(1);
  });

  test('matches names containing an apostrophe', async () => {
    addEpisode('q1', "/data/TV/X/Bob's Show.mkv");

    const result = await importer.import(fileFor("TV/X/Bob's Show.mkv"));

    expect(result.matched).toBe(1);
  });

  test('matches across the basename batch boundary', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `TV/X/ep${i}.mkv`);
    names.forEach((n, i) => addEpisode(`b${i}`, `/data/${n}`));

    const result = await importer.import(fileFor(...names));

    expect(result).toEqual({ matched: 150, unmatched: [], programs: 150 });
  });

  test('counts a program with two files once', async () => {
    sqlite
      .prepare('insert into program_version values (?, ?, ?)')
      .run('v1b', 1_000_000, 'p1');
    sqlite
      .prepare('insert into program_media_file values (?, ?, ?)')
      .run('f1b', '/backup/TV/X/a.mkv', 'v1b');

    const result = await importer.import(fileFor('TV/X/a.mkv'));

    expect(result.programs).toBe(1);
  });

  test('importing twice is idempotent', async () => {
    const first = await importer.import(file);
    const second = await importer.import(file);

    expect(second).toEqual(first);
    expect(markers.offsetsFor(['p1'])).toEqual(new Map([['p1', [660_000]]]));
  });
});
