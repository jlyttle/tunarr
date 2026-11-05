import { KEYS } from '@/types/inject.js';
import { chunk } from 'lodash-es';
import { inArray, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import type { DrizzleDBAccess } from './schema/index.ts';
import { ProgramBreakMarker } from './schema/ProgramBreakMarker.ts';

const InArrayChunkSize = 500;

export type BreakMarkerRow = {
  programId: string;
  offsetsMs: number[];
  detector: string;
};

@injectable()
export class BreakMarkerDB {
  constructor(@inject(KEYS.DrizzleDB) private db: DrizzleDBAccess) {}

  replace(rows: BreakMarkerRow[]): void {
    const importedAt = Date.now();
    this.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(ProgramBreakMarker)
          .values({ ...row, importedAt })
          .onConflictDoUpdate({
            target: ProgramBreakMarker.programId,
            set: {
              offsetsMs: sql`excluded.offsets_ms`,
              detector: sql`excluded.detector`,
              importedAt: sql`excluded.imported_at`,
            },
          })
          .run();
      }
    });
  }

  offsetsFor(programIds: readonly string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const ids of chunk(programIds, InArrayChunkSize)) {
      const found = this.db
        .select()
        .from(ProgramBreakMarker)
        .where(inArray(ProgramBreakMarker.programId, ids))
        .all();
      for (const row of found) {
        result.set(row.programId, row.offsetsMs);
      }
    }
    return result;
  }
}
