import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema } from '../../db/schema/index.ts';
import { BreakAnalysisRepository } from './BreakAnalysisRepository.ts';
import {
  evaluationFixture,
  candidateFixture,
} from '../../testing/BreakAnalysisFixtures.ts';

describe('break analysis persistence', () => {
  let sqlite: Sqlite.Database;
  let repository: BreakAnalysisRepository;
  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    // Migration is exercised against real SQLite, including the unique claim index.
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(
      readFileSync(
        new URL(
          '../../migration/db/sql/0046_episode_break_analysis.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    repository = new BreakAnalysisRepository(
      drizzle(sqlite, { schema, casing: 'snake_case' }),
    );
  });
  afterEach(() => sqlite.close());
  test('persists zero results, reuses matching runs, and preserves history on force', () => {
    const result = {
      ...evaluationFixture().episodes[0]!.result,
      status: 'running' as const,
    };
    expect(repository.claim(result, false).kind).toBe('claimed');
    expect(repository.finish({ ...result, status: 'completed' })).toBe(true);
    expect(repository.claim({ ...result, id: 'second' }, false).kind).toBe(
      'cached',
    );
    expect(repository.claim({ ...result, id: 'second' }, true).kind).toBe(
      'claimed',
    );
    expect(
      sqlite.prepare('select count(*) as n from program_break_analysis').get(),
    ).toEqual({ n: 2 });
  });
  test('serializes independent requests and recovers expired claims', () => {
    const result = {
      ...evaluationFixture().episodes[0]!.result,
      status: 'running' as const,
    };
    repository.claim(result, true);
    expect(repository.claim({ ...result, id: 'second' }, true).kind).toBe(
      'busy',
    );
    sqlite.exec('update program_break_analysis set lease_expires_at = 0');
    expect(repository.claim({ ...result, id: 'second' }, true).kind).toBe(
      'claimed',
    );
    expect(repository.finish({ ...result, status: 'completed' })).toBe(false);
    expect(
      sqlite
        .prepare('select status from program_break_analysis where uuid = ?')
        .get(result.id),
    ).toEqual({ status: 'interrupted' });
  });
  test('qualification never exposes failed, stale, or rejected candidates', () => {
    const result = evaluationFixture().episodes[0]!.result;
    result.candidates = [
      candidateFixture(),
      {
        ...candidateFixture(),
        timestampMs: 150050,
        evidence: {
          ...candidateFixture().evidence,
          blackStartMs: 149300,
          blackEndMs: 150500,
        },
      },
      { ...candidateFixture(), accepted: false, reasons: ['runtime-cap'] },
    ];
    expect(repository.expose(result).usableBreaks).toEqual([]);
    repository.qualify({
      configHash: result.configHash,
      detectorVersion: result.detectorVersion,
      datasetId: 'real',
      evaluationHash: 'hash',
      acknowledgedBy: 'reviewer',
      createdAt: 1,
    });
    expect(
      repository.expose({ ...result, status: 'failed' }).usableBreaks,
    ).toEqual([]);
    expect(repository.expose(result, true).usableBreaks).toEqual([]);
    expect(repository.expose(result).usableBreaks).toHaveLength(1);
    expect(
      repository.expose({ ...result, configHash: 'different' }).qualified,
    ).toBe(false);
  });
  test('deleting a media version cascades only its associated results', () => {
    sqlite.exec(
      'CREATE TABLE program(uuid TEXT PRIMARY KEY); CREATE TABLE program_version(uuid TEXT PRIMARY KEY); CREATE TABLE program_media_file(uuid TEXT PRIMARY KEY);',
    );
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(
      "INSERT INTO program VALUES ('p'); INSERT INTO program_version VALUES ('v'); INSERT INTO program_media_file VALUES ('f');",
    );
    const result = {
      ...evaluationFixture().episodes[0]!.result,
      status: 'running' as const,
      programId: 'p',
      programVersionId: 'v',
      mediaFileId: 'f',
    };
    repository.claim(result, true);
    repository.finish({ ...result, status: 'completed' });
    sqlite.exec("DELETE FROM program_version WHERE uuid = 'v'");
    expect(repository.history('p')).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM program').get()).toEqual({
      n: 1,
    });
  });
});
