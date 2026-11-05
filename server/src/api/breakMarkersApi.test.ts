import type { BreakMarkerFile } from '@tunarr/types/api';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { BreakMarkerDB } from '../db/BreakMarkerDB.ts';
import { schema } from '../db/schema/index.ts';
import { BreakMarkerImporter } from '../services/break-markers/BreakMarkerImporter.ts';
import { breakMarkersApi } from './breakMarkersApi.ts';

const importerRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../container.ts', () => ({
  container: { get: vi.fn(() => importerRef.current) },
}));

const file: BreakMarkerFile = {
  schema: 1,
  detector: 'det',
  show: 'X',
  threshold: 0.5,
  episodes: [
    {
      relativePath: 'TV/X/a.mkv',
      durationMs: 1_000_000,
      breaks: [{ offsetMs: 660_000, score: 1 }],
    },
  ],
};

describe('POST /break-markers', () => {
  test('importing the same file twice leaves the stored offsets unchanged', async () => {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(
      readFileSync(
        new URL('../migration/db/sql/0058_break_markers.sql', import.meta.url),
        'utf8',
      ),
    );
    sqlite.exec(`
      create table program (uuid text primary key, type text not null);
      create table program_version (uuid text primary key, duration integer not null, program_id text not null);
      create table program_media_file (uuid text primary key, path text not null, program_version_id text not null);
      insert into program values ('p1', 'episode');
      insert into program_version values ('v1', 1000000, 'p1');
      insert into program_media_file values ('f1', '/data/TV/X/a.mkv', 'v1');
    `);
    const db = drizzle(sqlite, { schema, casing: 'snake_case' });
    const markers = new BreakMarkerDB(db);
    importerRef.current = new BreakMarkerImporter(db, markers);

    const app = Fastify()
      .setValidatorCompiler(validatorCompiler)
      .setSerializerCompiler(serializerCompiler)
      .withTypeProvider<ZodTypeProvider>();
    await app.register(breakMarkersApi);
    await app.ready();

    const first = await app.inject({
      method: 'POST',
      url: '/break-markers',
      payload: file,
    });
    const offsetsAfterFirst = markers.offsetsFor(['p1']);
    const second = await app.inject({
      method: 'POST',
      url: '/break-markers',
      payload: file,
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ matched: 1, unmatched: [] });
    expect(markers.offsetsFor(['p1'])).toEqual(offsetsAfterFirst);
    expect(offsetsAfterFirst).toEqual(new Map([['p1', [660_000]]]));
    await app.close();
    sqlite.close();
  });
});
