import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { KyselifyBetter } from './KyselifyBetter.ts';
import { Program } from './Program.ts';

export const ProgramBreakMarker = sqliteTable('program_break_marker', {
  programId: text()
    .primaryKey()
    .references(() => Program.uuid, { onDelete: 'cascade' }),
  offsetsMs: text({ mode: 'json' }).$type<number[]>().notNull(),
  detector: text().notNull(),
  importedAt: integer().notNull(),
});

export type ProgramBreakMarkerTable = KyselifyBetter<typeof ProgramBreakMarker>;
