import type { BreakAnalysisResult } from '@tunarr/types/schemas';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { Program } from './Program.ts';
import { ProgramVersion } from './ProgramVersion.ts';
import { ProgramMediaFile } from './ProgramMediaFile.ts';
import type { KyselifyBetter } from './KyselifyBetter.ts';

export const ProgramBreakAnalysis = sqliteTable(
  'program_break_analysis',
  {
    uuid: text().primaryKey(),
    programId: text().references(() => Program.uuid, { onDelete: 'cascade' }),
    programVersionId: text().references(() => ProgramVersion.uuid, {
      onDelete: 'cascade',
    }),
    mediaFileId: text().references(() => ProgramMediaFile.uuid, {
      onDelete: 'cascade',
    }),
    sourceFingerprint: text().notNull(),
    detectorVersion: text().notNull(),
    configHash: text().notNull(),
    status: text({
      enum: ['running', 'completed', 'failed', 'skipped', 'interrupted'],
    }).notNull(),
    createdAt: integer().notNull(),
    leaseExpiresAt: integer(),
    // A single nullable unique slot bounds analysis across CLI/server processes.
    claimKey: text(),
    result: text({ mode: 'json' }).$type<BreakAnalysisResult>().notNull(),
  },
  (t) => [
    uniqueIndex('program_break_analysis_claim').on(t.claimKey),
    index('program_break_analysis_program').on(t.programId, t.createdAt),
    index('program_break_analysis_cache').on(
      t.sourceFingerprint,
      t.detectorVersion,
      t.configHash,
    ),
  ],
);

export const BreakDetectorQualification = sqliteTable(
  'break_detector_qualification',
  {
    configHash: text().notNull(),
    detectorVersion: text().notNull(),
    evaluationHash: text().notNull(),
    datasetId: text().notNull(),
    acknowledgedBy: text().notNull(),
    createdAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex('break_detector_qualification_version').on(
      t.detectorVersion,
      t.configHash,
    ),
  ],
);

export type ProgramBreakAnalysisTable = KyselifyBetter<
  typeof ProgramBreakAnalysis
>;
export type BreakDetectorQualificationTable = KyselifyBetter<
  typeof BreakDetectorQualification
>;
