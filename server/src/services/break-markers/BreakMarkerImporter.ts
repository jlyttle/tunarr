import { KEYS } from '@/types/inject.js';
import type {
  BreakMarkerFile,
  BreakMarkerImportResult,
} from '@tunarr/types/api';
import { and, eq, like, or } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { chunk } from 'lodash-es';
import { basename } from 'node:path/posix';
import { BreakMarkerDB } from '../../db/BreakMarkerDB.ts';
import { Program } from '../../db/schema/Program.ts';
import { ProgramMediaFile } from '../../db/schema/ProgramMediaFile.ts';
import { ProgramVersion } from '../../db/schema/ProgramVersion.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';

const DurationToleranceMs = 2000;
const BasenameBatchSize = 100;

export type MarkerCandidate = {
  programId: string;
  path: string;
  durationMs: number;
};

export type MarkerRow = { programId: string; offsetsMs: number[] };

export function matchMarkerEpisodes(
  episodes: BreakMarkerFile['episodes'],
  candidates: MarkerCandidate[],
): { rows: MarkerRow[]; unmatched: string[] } {
  const normalized = candidates.map((candidate) => ({
    ...candidate,
    path: candidate.path.normalize('NFC'),
  }));
  const rows: MarkerRow[] = [];
  const unmatched: string[] = [];
  for (const episode of episodes) {
    const suffix = `/${episode.relativePath.normalize('NFC')}`;
    const matches = normalized.filter(
      (candidate) =>
        candidate.path.endsWith(suffix) &&
        Math.abs(candidate.durationMs - episode.durationMs) <=
          DurationToleranceMs,
    );
    if (matches.length === 0) {
      unmatched.push(episode.relativePath);
      continue;
    }
    const offsetsMs = episode.breaks.map((b) => b.offsetMs);
    for (const match of matches) {
      rows.push({ programId: match.programId, offsetsMs });
    }
  }
  return { rows, unmatched };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@injectable()
export class BreakMarkerImporter {
  constructor(
    @inject(KEYS.DrizzleDB) private db: DrizzleDBAccess,
    @inject(BreakMarkerDB) private breakMarkerDB: BreakMarkerDB,
  ) {}

  import(file: BreakMarkerFile): Promise<BreakMarkerImportResult> {
    const candidates = this.findCandidates(file.episodes);
    const { rows, unmatched } = matchMarkerEpisodes(file.episodes, candidates);
    this.breakMarkerDB.replace(
      rows.map((row) => ({ ...row, detector: file.detector })),
    );
    return Promise.resolve({
      matched: file.episodes.length - unmatched.length,
      unmatched,
      programs: rows.length,
    });
  }

  private findCandidates(
    episodes: BreakMarkerFile['episodes'],
  ): MarkerCandidate[] {
    const names = [...new Set(episodes.map((e) => basename(e.relativePath)))];
    const found = new Map<string, MarkerCandidate>();
    for (const batch of chunk(names, BasenameBatchSize)) {
      const results = this.db
        .select({
          fileId: ProgramMediaFile.uuid,
          programId: Program.uuid,
          path: ProgramMediaFile.path,
          durationMs: ProgramVersion.duration,
        })
        .from(Program)
        .innerJoin(ProgramVersion, eq(ProgramVersion.programId, Program.uuid))
        .innerJoin(
          ProgramMediaFile,
          eq(ProgramMediaFile.programVersionId, ProgramVersion.uuid),
        )
        .where(
          and(
            eq(Program.type, 'episode'),
            or(
              ...batch.flatMap((name) => [
                like(ProgramMediaFile.path, `%/${escapeLike(name)}`),
                like(
                  ProgramMediaFile.path,
                  `%/${escapeLike(name.normalize('NFD'))}`,
                ),
              ]),
            ),
          ),
        )
        .all();
      for (const { fileId, ...candidate } of results) {
        found.set(fileId, candidate);
      }
    }
    return [...found.values()];
  }
}
