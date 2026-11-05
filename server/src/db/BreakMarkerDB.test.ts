import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BreakMarkerDB } from './BreakMarkerDB.ts';
import { schema } from './schema/index.ts';

describe('BreakMarkerDB', () => {
  let sqlite: Sqlite.Database;
  let markers: BreakMarkerDB;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(
      readFileSync(
        new URL('../migration/db/sql/0058_break_markers.sql', import.meta.url),
        'utf8',
      ),
    );
    markers = new BreakMarkerDB(
      drizzle(sqlite, { schema, casing: 'snake_case' }),
    );
  });
  afterEach(() => sqlite.close());

  test('replace then offsetsFor returns stored offsets', () => {
    markers.replace([
      { programId: 'p1', offsetsMs: [100, 200], detector: 'd' },
    ]);

    expect(markers.offsetsFor(['p1', 'p2'])).toEqual(
      new Map([['p1', [100, 200]]]),
    );
  });

  test('replace overwrites and accepts an empty list', () => {
    markers.replace([{ programId: 'p1', offsetsMs: [100], detector: 'd' }]);
    markers.replace([{ programId: 'p1', offsetsMs: [], detector: 'd' }]);

    expect(markers.offsetsFor(['p1']).get('p1')).toEqual([]);
  });

  test('offsetsFor handles more than 500 ids', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      programId: `p${i}`,
      offsetsMs: [i],
      detector: 'd',
    }));
    markers.replace(rows);

    const result = markers.offsetsFor(rows.map((r) => r.programId));

    expect(result.size).toBe(1200);
    expect(result.get('p1199')).toEqual([1199]);
  });
});
