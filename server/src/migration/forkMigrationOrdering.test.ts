import path from 'node:path';
import tmp from 'tmp-promise';
import { test as baseTest, describe, expect } from 'vitest';
import { DBAccess } from '../db/DBAccess.ts';
import { makeMigrationFromSqlFile } from './db/util.ts';

// The fork's migrations, keyed as fork databases recorded them before upstream's
// 0045-0053 existed.
const ForkMigrations: [string, string][] = [
  ['migration1781911575', './sql/0054_premium_misty_knight.sql'],
  ['migration1789257600', './sql/0055_episode_break_analysis.sql'],
];

// Upstream's migrations exactly as upstream ships them.
const UpstreamMigrations: [string, string][] = [
  ['migration1779655043', './sql/0045_lean_violations.sql'],
  ['migration1782772646', './sql/0046_melted_captain_flint.sql'],
  ['migration1789851695', './sql/0047_eac3_audio_format_constraint.sql'],
  ['migration1790033149', './sql/0048_old_firestar.sql'],
  ['migration1790034899', './sql/0049_slim_toad_men.sql'],
  ['migration1790035117', './sql/0050_whole_molly_hayes.sql'],
  ['migration1790105123', './sql/0051_striped_marvel_apes.sql'],
  ['migration1790271998', './sql/0052_colorful_ken_ellis.sql'],
  ['migration1791321608', './sql/0053_real_raza.sql'],
];

const LastSharedMigration = 'migration1777908252';

const test = baseTest.extend<{ dbDir: string }>({
  dbDir: async ({}, use) => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    await use(dir.path);
    for (const name of ['fresh.db', 'fork.db', 'upstream.db']) {
      await DBAccess.instance.closeConnection(path.join(dir.path, name));
    }
    await dir.cleanup();
  },
});

function connect(dbPath: string) {
  return DBAccess.instance.getOrCreateConnection(dbPath);
}

async function createFreshDatabase(dbPath: string) {
  const conn = connect(dbPath);
  await conn.syncMigrationTablesIfNecessary();
  await conn.runDBMigrations();
  return conn;
}

async function createDatabaseAt(
  dbPath: string,
  extraMigrations: [string, string][],
) {
  const conn = connect(dbPath);
  await conn.syncMigrationTablesIfNecessary();
  await conn.runDBMigrations(LastSharedMigration);
  for (const [name, file] of extraMigrations) {
    makeMigrationFromSqlFile(file).upDrizzle(conn.drizzle);
    conn.sqlite
      .prepare('INSERT INTO migrations (name, timestamp) VALUES (?, ?)')
      .run(name, new Date().toISOString());
  }
  return conn;
}

function schemaOf(dbPath: string) {
  return connect(dbPath)
    .sqlite.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

function appliedMigrations(dbPath: string) {
  return connect(dbPath)
    .sqlite.prepare('SELECT name FROM migrations ORDER BY name')
    .all()
    .map((row) => (row as { name: string }).name);
}

function insertTranscodeConfig(dbPath: string, aspectRatioMode?: string) {
  const columns = [
    'uuid',
    'name',
    'thread_count',
    'hardware_acceleration_mode',
    'resolution',
    'video_format',
    'video_bit_rate',
    'video_buffer_size',
    'audio_channels',
    'audio_format',
    'audio_bit_rate',
    'audio_buffer_size',
    'audio_sample_rate',
  ];
  const values: unknown[] = [
    'tc-1',
    'Crop config',
    0,
    'none',
    JSON.stringify({ widthPx: 1920, heightPx: 1080 }),
    'h264',
    2000,
    4000,
    2,
    'aac',
    192,
    384,
    48,
  ];
  if (aspectRatioMode) {
    columns.push('aspect_ratio_mode');
    values.push(aspectRatioMode);
  }
  connect(dbPath)
    .sqlite.prepare(
      `INSERT INTO transcode_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
}

function insertChannel(dbPath: string, forkColumns: boolean) {
  const columns = [
    'uuid',
    'created_at',
    'updated_at',
    'number',
    'name',
    'duration',
    'start_time',
    'group_title',
    'disable_filler_overlay',
    'guide_minimum_duration',
    'icon',
    'stealth',
    'offline',
    'stream_mode',
    'transcode_config_id',
  ];
  const values: unknown[] = [
    'ch-1',
    0,
    0,
    1,
    'Channel',
    0,
    0,
    'tunarr',
    0,
    30000,
    JSON.stringify({
      path: '',
      width: 0,
      duration: 0,
      position: 'bottom-right',
    }),
    0,
    JSON.stringify({ mode: 'pic' }),
    'hls',
    'tc-1',
  ];
  if (forkColumns) {
    columns.push('subtitle_delivery_method', 'subtitle_unsupported_fallback');
    values.push('hls', 'none');
  }
  connect(dbPath)
    .sqlite.prepare(
      `INSERT INTO channel (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
}

function insertBreakQualification(dbPath: string) {
  connect(dbPath)
    .sqlite.prepare(
      `INSERT INTO break_detector_qualification
       (config_hash, detector_version, evaluation_hash, dataset_id, acknowledged_by, created_at)
       VALUES ('cfg', 'v1', 'eval', 'set', 'me', 1)`,
    )
    .run();
}

function row(dbPath: string, query: string) {
  return connect(dbPath).sqlite.prepare(query).get();
}

describe('fork and upstream migration ordering', () => {
  test('a database migrated by the fork branch gains upstream migrations and keeps fork data', async ({
    dbDir,
  }) => {
    const freshPath = path.join(dbDir, 'fresh.db');
    const forkPath = path.join(dbDir, 'fork.db');
    await createFreshDatabase(freshPath);
    await createDatabaseAt(forkPath, ForkMigrations);
    insertTranscodeConfig(forkPath, 'crop');
    insertChannel(forkPath, true);
    insertBreakQualification(forkPath);

    await DBAccess.instance.migrateExistingDatabase(forkPath);

    expect(schemaOf(forkPath)).toEqual(schemaOf(freshPath));
    expect(appliedMigrations(forkPath)).toEqual(appliedMigrations(freshPath));
    expect(
      row(
        forkPath,
        "SELECT aspect_ratio_mode, name FROM transcode_config WHERE uuid = 'tc-1'",
      ),
    ).toEqual({ aspect_ratio_mode: 'crop', name: 'Crop config' });
    expect(
      row(
        forkPath,
        'SELECT subtitle_delivery_method, subtitle_unsupported_fallback, transcode_config_id FROM channel',
      ),
    ).toEqual({
      subtitle_delivery_method: 'hls',
      subtitle_unsupported_fallback: 'none',
      transcode_config_id: 'tc-1',
    });
    expect(
      row(forkPath, 'SELECT count(*) AS n FROM break_detector_qualification'),
    ).toEqual({ n: 1 });
  });

  test('a database migrated by upstream gains the fork migrations', async ({
    dbDir,
  }) => {
    const freshPath = path.join(dbDir, 'fresh.db');
    const upstreamPath = path.join(dbDir, 'upstream.db');
    await createFreshDatabase(freshPath);
    await createDatabaseAt(upstreamPath, UpstreamMigrations);
    insertTranscodeConfig(upstreamPath);
    insertChannel(upstreamPath, false);

    await DBAccess.instance.migrateExistingDatabase(upstreamPath);

    expect(schemaOf(upstreamPath)).toEqual(schemaOf(freshPath));
    expect(appliedMigrations(upstreamPath)).toEqual(
      appliedMigrations(freshPath),
    );
    expect(
      row(
        upstreamPath,
        "SELECT aspect_ratio_mode FROM transcode_config WHERE uuid = 'tc-1'",
      ),
    ).toEqual({ aspect_ratio_mode: 'preserve' });
    expect(
      row(upstreamPath, 'SELECT subtitle_delivery_method FROM channel'),
    ).toEqual({ subtitle_delivery_method: 'burn' });
  });

  test('a fresh database accepts every transcode_config the schema allows', async ({
    dbDir,
  }) => {
    const freshPath = path.join(dbDir, 'fresh.db');
    await createFreshDatabase(freshPath);
    insertTranscodeConfig(freshPath, 'stretch');

    connect(freshPath)
      .sqlite.prepare(
        "UPDATE transcode_config SET audio_format = 'eac3' WHERE uuid = 'tc-1'",
      )
      .run();

    expect(
      row(
        freshPath,
        "SELECT aspect_ratio_mode, audio_format FROM transcode_config WHERE uuid = 'tc-1'",
      ),
    ).toEqual({ aspect_ratio_mode: 'stretch', audio_format: 'eac3' });
  });
});
