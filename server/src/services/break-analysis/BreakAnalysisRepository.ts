import type { BreakAnalysisResult } from '@tunarr/types/schemas';
import { breakScanWindow } from './BreakDetector.ts';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import {
  BreakDetectorQualification,
  ProgramBreakAnalysis,
} from '../../db/schema/ProgramBreakAnalysis.ts';

const table = ProgramBreakAnalysis;
export class BreakAnalysisRepository {
  constructor(private readonly db: DrizzleDBAccess) {}

  claim(
    result: BreakAnalysisResult,
    force: boolean,
  ):
    | { kind: 'claimed' | 'cached'; result: BreakAnalysisResult }
    | { kind: 'busy' } {
    return this.db.transaction(
      (tx) => {
        const expired = tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.status, 'running'),
              lt(table.leaseExpiresAt, Date.now()),
            ),
          )
          .all();
        for (const row of expired) {
          tx.update(table)
            .set({
              status: 'interrupted',
              claimKey: null,
              leaseExpiresAt: null,
              result: {
                ...row.result,
                status: 'interrupted',
                finishedAt: Date.now(),
                error: 'abandoned-analysis',
                usableBreaks: [],
              },
            })
            .where(eq(table.uuid, row.uuid))
            .run();
        }
        if (!force) {
          const cached = tx
            .select()
            .from(table)
            .where(
              and(
                eq(table.sourceFingerprint, result.sourceFingerprint),
                eq(table.detectorVersion, result.detectorVersion),
                eq(table.configHash, result.configHash),
                eq(table.status, 'completed'),
              ),
            )
            .orderBy(desc(table.createdAt))
            .get();
          if (cached) return { kind: 'cached' as const, result: cached.result };
        }
        if (
          tx
            .select({ uuid: table.uuid })
            .from(table)
            .where(eq(table.claimKey, 'decoder'))
            .get()
        )
          return { kind: 'busy' as const };
        tx.insert(table)
          .values({
            uuid: result.id,
            programId: result.programId,
            programVersionId: result.programVersionId,
            mediaFileId: result.mediaFileId,
            sourceFingerprint: result.sourceFingerprint,
            detectorVersion: result.detectorVersion,
            configHash: result.configHash,
            status: 'running',
            createdAt: result.createdAt,
            result,
            claimKey: 'decoder',
            leaseExpiresAt: Date.now() + 60000,
          })
          .run();
        return { kind: 'claimed' as const, result };
      },
      { behavior: 'immediate' },
    );
  }

  heartbeat(id: string) {
    return (
      this.db
        .update(table)
        .set({ leaseExpiresAt: Date.now() + 60000 })
        .where(and(eq(table.uuid, id), eq(table.status, 'running')))
        .run().changes === 1
    );
  }

  finish(result: BreakAnalysisResult) {
    return (
      this.db
        .update(table)
        .set({
          status: result.status,
          result: { ...result, qualified: false, usableBreaks: [] },
          claimKey: null,
          leaseExpiresAt: null,
        })
        .where(and(eq(table.uuid, result.id), eq(table.status, 'running')))
        .run().changes === 1
    );
  }

  recordFailure(result: BreakAnalysisResult) {
    this.db
      .insert(table)
      .values({
        uuid: result.id,
        programId: result.programId,
        programVersionId: result.programVersionId,
        mediaFileId: result.mediaFileId,
        sourceFingerprint: result.sourceFingerprint,
        detectorVersion: result.detectorVersion,
        configHash: result.configHash,
        status: result.status,
        createdAt: result.createdAt,
        result,
      })
      .run();
  }

  history(programId: string, limit = 100, offset = 0) {
    return this.db
      .select()
      .from(table)
      .where(eq(table.programId, programId))
      .orderBy(desc(table.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map((r) => r.result);
  }

  qualify(value: typeof BreakDetectorQualification.$inferInsert) {
    this.db
      .insert(BreakDetectorQualification)
      .values(value)
      .onConflictDoUpdate({
        target: [
          BreakDetectorQualification.detectorVersion,
          BreakDetectorQualification.configHash,
        ],
        set: value,
      })
      .run();
  }

  expose(result: BreakAnalysisResult, stale = false): BreakAnalysisResult {
    stale ||= result.stale;
    const qualified = !!this.db
      .select()
      .from(BreakDetectorQualification)
      .where(
        and(
          eq(BreakDetectorQualification.configHash, result.configHash),
          eq(
            BreakDetectorQualification.detectorVersion,
            result.detectorVersion,
          ),
        ),
      )
      .get();
    const window = breakScanWindow(result.runtimeMs, result.config);
    return {
      ...result,
      qualified,
      stale,
      usableBreaks:
        qualified && !stale && result.status === 'completed'
          ? result.candidates.filter(
              (c) =>
                c.accepted &&
                c.confidence === 'high' &&
                c.evidence.blackStartMs >= window.startMs &&
                c.evidence.blackEndMs <= window.endMs,
            )
          : [],
    };
  }
}
