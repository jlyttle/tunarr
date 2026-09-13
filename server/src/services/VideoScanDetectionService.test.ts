import { KEYS } from '../types/inject.ts';
import { ProgramDB } from '../db/ProgramDB.ts';
import { ProgramUpsertRepository } from '../db/program/ProgramUpsertRepository.ts';
import type {
  NewProgramWithRelations,
  ProgramWithExternalIds,
} from '../db/schema/derivedTypes.ts';
import Sqlite from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from 'vitest';
import { instance, mock } from 'ts-mockito';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { DB } from '../db/schema/db.ts';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import { FfmpegInfo } from '../ffmpeg/ffmpegInfo.ts';
import { VideoScanDetectionService } from './VideoScanDetectionService.ts';
import { DetectMissingInterlaceMetadataTask } from '../tasks/DetectMissingInterlaceMetadataTask.ts';
import { TaskRegistry } from '../tasks/TaskRegistry.ts';
import { container } from '../container.ts';

let sqlite: Sqlite.Database;
let db: Kysely<DB>;
let service: VideoScanDetectionService;
let probe: MockInstance<FfmpegInfo['probeScanKind']>;
const server = {
  uuid: 'server',
  type: 'plex',
  uri: 'http://plex',
  accessToken: 'secret',
  replacePaths: [],
} as unknown as MediaSourceWithRelations;

function addVersion(id: string, scan = 'unknown', kind = 'video') {
  sqlite
    .prepare('INSERT INTO program VALUES (?, ?, ?)')
    .run(id, 'server', 1426432);
  sqlite
    .prepare('INSERT INTO program_version VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, scan, 1, 1, 1426432);
  sqlite
    .prepare('INSERT INTO program_media_stream VALUES (?, ?, ?, ?)')
    .run(id, id, 0, kind);
  sqlite
    .prepare('INSERT INTO program_media_file VALUES (?, ?, ?)')
    .run(id, id, '/missing/episode.mkv');
  sqlite
    .prepare('INSERT INTO program_external_id VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'plex', 'server', `/library/parts/${id}/file.mkv`);
}

beforeEach(() => {
  sqlite = new Sqlite(':memory:');
  // Minimal real SQLite schema: exercise the service's queries and guarded updates.
  sqlite.exec(`
    CREATE TABLE program (uuid TEXT PRIMARY KEY, media_source_id TEXT, duration INTEGER);
    CREATE TABLE program_version (uuid TEXT PRIMARY KEY, program_id TEXT, scan_kind TEXT, updated_at INTEGER, created_at INTEGER, duration INTEGER);
    CREATE TABLE program_media_stream (uuid TEXT PRIMARY KEY, program_version_id TEXT, "index" INTEGER, stream_kind TEXT);
    CREATE TABLE program_media_file (uuid TEXT PRIMARY KEY, program_version_id TEXT, path TEXT);
    CREATE TABLE program_external_id (uuid TEXT PRIMARY KEY, program_uuid TEXT, source_type TEXT, media_source_id TEXT, external_file_path TEXT);
    CREATE TABLE channel (uuid TEXT PRIMARY KEY, lineup TEXT, schedule TEXT);
    INSERT INTO channel VALUES ('channel', '[{"id":"episode","duration":1426432}]', '{"startTime":100}');
    CREATE TABLE custom_show (uuid TEXT PRIMARY KEY, content TEXT);
    INSERT INTO custom_show VALUES ('show', '["episode"]');
    CREATE TABLE program_chapter (uuid TEXT PRIMARY KEY, program_version_id TEXT, start_time INTEGER);
    INSERT INTO program_chapter VALUES ('chapter', 'episode', 66);
  `);
  db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  });
  const mediaSourceDB = instance(mock(MediaSourceDB));
  vi.spyOn(mediaSourceDB, 'getById').mockResolvedValue(server);
  const info = new FfmpegInfo('ffmpeg', 'ffprobe');
  probe = vi.spyOn(info, 'probeScanKind').mockResolvedValue('interlaced');
  service = new VideoScanDetectionService(db, mediaSourceDB, info);
});

afterEach(async () => {
  await db.destroy();
  vi.restoreAllMocks();
});

describe('upfront scan detection', () => {
  test('updates only scan kind and timestamp, preserving programs, chapters and programming', async () => {
    addVersion('episode');
    const tables = [
      'program',
      'program_media_stream',
      'program_media_file',
      'program_external_id',
      'channel',
      'custom_show',
      'program_chapter',
    ];
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all(),
    );
    const versionBefore = await db
      .selectFrom('programVersion')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(await service.detectMissing()).toMatchObject({
      examined: 1,
      updated: 1,
      failed: 0,
    });
    const after = await db
      .selectFrom('programVersion')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(after).toEqual({
      ...versionBefore,
      scanKind: 'interlaced',
      updatedAt: expect.any(Number),
    });
    expect(after.updatedAt).toBeGreaterThan(versionBefore.updatedAt);
    expect(
      tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'http://plex/library/parts/episode/file.mkv?X-Plex-Token=secret',
      }),
      0,
    );
  });

  test('skips known and audio-only versions and scopes import detection to imported programs', async () => {
    addVersion('known', 'progressive');
    addVersion('audio', 'unknown', 'audio');
    addVersion('new');
    addVersion('other');
    expect(
      await service.detectMissing(['known', 'audio', 'new']),
    ).toMatchObject({ examined: 1, updated: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(
      await db
        .selectFrom('programVersion')
        .select('scanKind')
        .where('uuid', '=', 'other')
        .executeTakeFirst(),
    ).toEqual({ scanKind: 'unknown' });
  });

  test('continues after failed or inconclusive probes and retries on a later run', async () => {
    addVersion('a');
    addVersion('b');
    addVersion('c');
    probe
      .mockRejectedValueOnce(new Error('timeout with secret URL'))
      .mockResolvedValueOnce('unknown');
    expect(await service.detectMissing()).toMatchObject({
      examined: 3,
      updated: 1,
      failed: 1,
      inconclusive: 1,
    });
    expect(await service.detectMissing()).toMatchObject({
      examined: 2,
      updated: 2,
    });
  });

  test('does not overwrite a version replaced while its probe is running', async () => {
    addVersion('episode');
    probe.mockImplementationOnce(async () => {
      await db
        .updateTable('programVersion')
        .set({ updatedAt: 2, createdAt: 2 })
        .where('uuid', '=', 'episode')
        .execute();
      return 'interlaced';
    });
    expect(await service.detectMissing()).toMatchObject({
      updated: 0,
      skipped: 1,
    });
    expect(
      await db
        .selectFrom('programVersion')
        .select('scanKind')
        .executeTakeFirst(),
    ).toEqual({ scanKind: 'unknown' });
    expect(await service.detectMissing(['episode'])).toMatchObject({
      updated: 1,
    });
  });

  test('deduplicates simultaneous requests for a version', async () => {
    addVersion('episode');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    probe.mockImplementation(async () => {
      await gate;
      return 'interlaced';
    });
    const first = service.detectMissing();
    const second = service.detectMissing(['episode']);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('processes multiple pages with no more than two concurrent probes', async () => {
    for (let i = 0; i < 105; i++) addVersion(String(i).padStart(3, '0'));
    let active = 0;
    let peak = 0;
    probe.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return 'interlaced';
    });
    expect(await service.detectMissing()).toMatchObject({
      examined: 105,
      updated: 105,
    });
    expect(peak).toBe(2);
    expect(probe).toHaveBeenCalledTimes(105);
  });

  test('awaits detection after both initial import and a rescan replaces metadata', async () => {
    const upsert = instance(mock(ProgramUpsertRepository));
    vi.spyOn(upsert, 'upsertPrograms').mockImplementation(async () => {
      sqlite.exec(
        'DELETE FROM program; DELETE FROM program_version; DELETE FROM program_media_stream; DELETE FROM program_media_file; DELETE FROM program_external_id;',
      );
      addVersion('episode');
      return [{ uuid: 'episode' } as ProgramWithExternalIds];
    });
    const programDB = new ProgramDB(
      instance(mock()),
      instance(mock()),
      instance(mock()),
      upsert,
      instance(mock()),
      instance(mock()),
      instance(mock()),
      instance(mock()),
      service,
    );
    for (let i = 0; i < 2; i++) {
      await programDB.upsertPrograms([{} as NewProgramWithRelations]);
      expect(
        await db
          .selectFrom('programVersion')
          .select('scanKind')
          .executeTakeFirst(),
      ).toEqual({ scanKind: 'interlaced' });
    }
    expect(probe).toHaveBeenCalledTimes(2);
    probe.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      programDB.upsertPrograms([{} as NewProgramWithRelations]),
    ).resolves.toEqual([{ uuid: 'episode' }]);
  });

  test('registers a manually runnable task and resolves its dependencies', async () => {
    expect(TaskRegistry.getAll()).toHaveProperty(
      'DetectMissingInterlaceMetadataTask',
    );
    container.snapshot();
    try {
      (await container.rebind(KEYS.Database)).toConstantValue(db);
      (await container.rebind(MediaSourceDB)).toConstantValue(
        instance(mock(MediaSourceDB)),
      );
      (await container.rebind(FfmpegInfo)).toConstantValue(
        new FfmpegInfo('ffmpeg', 'ffprobe'),
      );
      expect(container.get(DetectMissingInterlaceMetadataTask)).toBeInstanceOf(
        DetectMissingInterlaceMetadataTask,
      );
    } finally {
      container.restore();
    }
  });
});
