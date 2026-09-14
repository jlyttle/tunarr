import {
  BreakAnalysisRequestSchema,
  BreakDetectorConfigSchema,
} from '@tunarr/types/schemas';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import type { DB } from '../../db/schema/db.ts';
import { schema } from '../../db/schema/index.ts';
import { HttpStreamSource } from '../../stream/types.ts';
import {
  BreakAnalysisService,
  fingerprintSource,
} from './BreakAnalysisService.ts';
import { BreakFeatureExtractor } from './BreakFeatureExtractor.ts';

const programId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const extraction = () => ({
  features: { video: [], audioDb: [] },
  probe: {
    format: { start_time: 0, duration: 1440 },
    streams: [],
    chapters: [],
    video: { index: 0, codec_type: 'video' },
    audio: { index: 1, codec_type: 'audio', channels: 2 },
    channels: 2,
  },
});
describe('analysis orchestration', () => {
  let sqlite: Sqlite.Database;
  let db: Kysely<DB>;
  let directory: string;
  let file: string;
  let service: BreakAnalysisService;
  const source = {
    uuid: 'source',
    type: 'local',
    uri: 'http://media',
    accessToken: 'VERY_SECRET_TOKEN',
    replacePaths: [],
  };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'tunarr-break-service-'));
    file = path.join(directory, 'episode.mkv');
    await writeFile(file, 'fixture');
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(`
      CREATE TABLE program (uuid TEXT PRIMARY KEY, media_source_id TEXT, tv_show_uuid TEXT, library_id TEXT, type TEXT);
      CREATE TABLE program_version (uuid TEXT PRIMARY KEY, program_id TEXT, updated_at INTEGER, created_at INTEGER, duration INTEGER);
      CREATE TABLE program_media_file (uuid TEXT PRIMARY KEY, program_version_id TEXT, path TEXT);
      CREATE TABLE program_external_id (uuid TEXT PRIMARY KEY, program_uuid TEXT, source_type TEXT, media_source_id TEXT, external_file_path TEXT, direct_file_path TEXT, external_key TEXT, updated_at INTEGER);
      CREATE TABLE program_chapter (uuid TEXT PRIMARY KEY, program_version_id TEXT, start_time INTEGER, end_time INTEGER, chapter_type TEXT);
      CREATE TABLE channel (uuid TEXT PRIMARY KEY, lineup TEXT);
      INSERT INTO channel VALUES ('channel', 'unchanged');
    `);
    sqlite.exec(
      readFileSync(
        new URL(
          '../../migration/db/sql/0046_episode_break_analysis.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    sqlite
      .prepare('INSERT INTO program VALUES (?, ?, ?, ?, ?)')
      .run(programId, 'source', 'series', 'library', 'episode');
    sqlite
      .prepare('INSERT INTO program_version VALUES (?, ?, ?, ?, ?)')
      .run(versionId, programId, 1, 1, 1440000);
    sqlite
      .prepare('INSERT INTO program_media_file VALUES (?, ?, ?)')
      .run('file', versionId, file);
    db = new Kysely<DB>({
      dialect: new SqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    source.type = 'local';
    service = new BreakAnalysisService(
      db,
      drizzle(sqlite, { schema, casing: 'snake_case' }),
      { getById: vi.fn(async () => source) } as unknown as MediaSourceDB,
      'ffmpeg',
      'ffprobe',
    );
    vi.spyOn(BreakFeatureExtractor.prototype, 'extract').mockResolvedValue(
      extraction(),
    );
  });
  afterEach(async () => {
    service.cancelAll();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  test('persists successful zero results, caches, forces reruns, and preserves programming', async () => {
    const request = BreakAnalysisRequestSchema.parse({
      programIds: [programId],
    });
    const first = await service.batch(request);
    expect(first[0]).toMatchObject({
      status: 'completed',
      programId,
      programVersionId: versionId,
      mediaFileId: 'file',
      candidates: [],
      usableBreaks: [],
    });
    expect((await service.batch(request))[0]!.id).toBe(first[0]!.id);
    expect((await service.batch({ ...request, force: true }))[0]!.id).not.toBe(
      first[0]!.id,
    );
    expect(BreakFeatureExtractor.prototype.extract).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT * FROM channel').all()).toEqual([
      { uuid: 'channel', lineup: 'unchanged' },
    ]);
    expect(await service.history(programId)).toHaveLength(2);
  });
  test('normalizes legacy exclusion settings and persists the actual scan window', async () => {
    const request = BreakAnalysisRequestSchema.parse({
      programIds: [programId],
      config: {
        startExclusionMs: 0,
        endExclusionMs: 0,
        startExclusionFraction: 0.1,
        endExclusionFraction: 0.05,
      },
    });
    const [result] = await service.batch(request);
    expect(result).toMatchObject({
      detectorVersion: 'conservative-fade-v3',
      scanWindow: { startMs: 240000, endMs: 1200000 },
      config: {
        startExclusionMs: 240000,
        endExclusionMs: 240000,
        startExclusionFraction: 0,
        endExclusionFraction: 0,
      },
    });
  });
  test('persists completed empty analysis for an episode exactly fifteen minutes long', async () => {
    vi.mocked(BreakFeatureExtractor.prototype.extract).mockRestore();
    sqlite
      .prepare('UPDATE program_version SET duration = ? WHERE uuid = ?')
      .run(900000, versionId);
    const [result] = await service.batch(
      BreakAnalysisRequestSchema.parse({ programIds: [programId] }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      candidates: [],
      usableBreaks: [],
      scanWindow: { startMs: 240000, endMs: 240000 },
    });
    expect((await service.history(programId))[0]!.scanWindow).toEqual(
      result!.scanWindow,
    );
  });
  test('changed source invalidates history and triggers a new run', async () => {
    const request = BreakAnalysisRequestSchema.parse({
      programIds: [programId],
    });
    const first = await service.batch(request);
    await writeFile(file, 'different file contents');
    expect((await service.history(programId))[0]!.stale).toBe(true);
    expect((await service.batch(request))[0]!.id).not.toBe(first[0]!.id);
  });
  test('revalidates cached results after acquiring the database claim', async () => {
    const request = BreakAnalysisRequestSchema.parse({
      programIds: [programId],
    });
    await service.batch(request);
    const claim = service.repository.claim.bind(service.repository);
    vi.spyOn(service.repository, 'claim').mockImplementationOnce(
      (result, force) => {
        const cached = claim(result, force);
        writeFileSync(file, 'source replaced while waiting');
        return cached;
      },
    );
    expect((await service.batch(request))[0]).toMatchObject({
      status: 'failed',
      error: 'source-changed',
      usableBreaks: [],
    });
  });
  test('source changes during decoding cannot commit successful results', async () => {
    vi.mocked(BreakFeatureExtractor.prototype.extract).mockImplementationOnce(
      async () => {
        await writeFile(file, 'changed during decoding');
        return extraction();
      },
    );
    expect(
      (
        await service.batch(
          BreakAnalysisRequestSchema.parse({ programIds: [programId] }),
        )
      )[0],
    ).toMatchObject({
      status: 'failed',
      error: 'source-changed',
      usableBreaks: [],
    });
  });
  test.each(['plex', 'jellyfin', 'emby'])(
    'resolves authenticated %s direct media and strips errors',
    async (type) => {
      source.type = type;
      await rm(file);
      sqlite
        .prepare(
          'INSERT INTO program_external_id VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'external',
          programId,
          type,
          'source',
          type === 'plex' ? '/library/parts/1/file.mkv' : 'item',
          file,
          'item',
          1,
        );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { headers: { etag: '"v1"' } })),
      );
      vi.mocked(BreakFeatureExtractor.prototype.extract).mockRejectedValueOnce(
        new Error('http://secret?token=VERY_SECRET_TOKEN'),
      );
      const results = await service.batch(
        BreakAnalysisRequestSchema.parse({ programIds: [programId] }),
      );
      expect(results[0]).toMatchObject({
        status: 'failed',
        error: 'analysis-failed',
      });
      expect(JSON.stringify(results)).not.toContain('VERY_SECRET_TOKEN');
      expect(
        JSON.stringify(
          sqlite.prepare('SELECT * FROM program_break_analysis').all(),
        ),
      ).not.toContain('VERY_SECRET_TOKEN');
      const resolved = vi.mocked(BreakFeatureExtractor.prototype.extract).mock
        .calls[0]![0];
      expect(resolved.type).toBe('http');
      expect(JSON.stringify(resolved)).toContain('VERY_SECRET_TOKEN');
    },
  );
  test('unsupported multipart inputs are explicit skipped results', async () => {
    sqlite
      .prepare('INSERT INTO program_media_file VALUES (?, ?, ?)')
      .run('second', versionId, file + '.part2');
    expect(
      (
        await service.batch(
          BreakAnalysisRequestSchema.parse({ programIds: [programId] }),
        )
      )[0],
    ).toMatchObject({
      status: 'skipped',
      error: 'unsupported-multipart-or-missing-file',
    });
    expect(BreakFeatureExtractor.prototype.extract).not.toHaveBeenCalled();
  });
  test('standalone cancellation and failure never resemble completed empty results', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await service.analyzeFile(file, 1440000, {
      config: BreakDetectorConfigSchema.parse({}),
      timeoutMs: 1000,
      threads: 1,
      signal: controller.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.usableBreaks).toEqual([]);
  });
  test('remote validators are hashed; missing validators are explicitly unverifiable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { headers: { etag: '"v1"' } })),
    );
    const input = new HttpStreamSource(
      'https://media/episode?token=VERY_SECRET_TOKEN',
    );
    const first = await fingerprintSource(input, 'provider-file');
    expect(first.verifiable).toBe(true);
    expect(JSON.stringify(first)).not.toContain('VERY_SECRET_TOKEN');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 405 })),
    );
    expect((await fingerprintSource(input, 'provider-file')).verifiable).toBe(
      false,
    );
  });
});
