import { inject, injectable } from 'inversify';
import { Kysely } from 'kysely';
import PQueue from 'p-queue';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import { DB } from '../db/schema/db.ts';
import { FfmpegInfo } from '../ffmpeg/ffmpegInfo.ts';
import { resolveProgramStreamSource } from '../stream/resolveProgramStreamSource.ts';
import { KEYS } from '../types/inject.ts';
import { InjectLogger } from '../util/inject.ts';
import { Logger } from '../util/logging/LoggerFactory.ts';

type DetectionOutcome = 'updated' | 'inconclusive' | 'failed' | 'skipped';
export type ScanDetectionSummary = Record<
  DetectionOutcome | 'examined',
  number
>;

@injectable()
export class VideoScanDetectionService {
  @InjectLogger() declare private readonly logger: Logger;
  private readonly queue = new PQueue({ concurrency: 2 });
  private readonly pending = new Map<string, Promise<DetectionOutcome>>();

  constructor(
    @inject(KEYS.Database) private readonly db: Kysely<DB>,
    @inject(MediaSourceDB) private readonly mediaSourceDB: MediaSourceDB,
    @inject(FfmpegInfo) private readonly ffmpegInfo: FfmpegInfo,
  ) {}

  // Used only by imports/rescans and the manual task, never by playback.
  async detectMissing(programIds?: string[]): Promise<ScanDetectionSummary> {
    const summary: ScanDetectionSummary = {
      examined: 0,
      updated: 0,
      inconclusive: 0,
      failed: 0,
      skipped: 0,
    };
    if (programIds?.length === 0) return summary;
    // Keep SQLite parameter counts bounded, even for large imports.
    const groups = programIds
      ? Array.from({ length: Math.ceil(programIds.length / 100) }, (_, i) =>
          programIds.slice(i * 100, i * 100 + 100),
        )
      : [undefined];
    for (const ids of groups) {
      let after = '';
      while (true) {
        let query = this.db
          .selectFrom('programVersion as version')
          .select(['version.uuid', 'version.updatedAt'])
          .where('version.scanKind', '=', 'unknown')
          .where('version.uuid', '>', after)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('programMediaStream as stream')
                .select('stream.uuid')
                .whereRef('stream.programVersionId', '=', 'version.uuid')
                .where('stream.streamKind', '=', 'video'),
            ),
          )
          .orderBy('version.uuid')
          .limit(100);
        if (ids) query = query.where('version.programId', 'in', ids);
        const versions = await query.execute();
        if (versions.length === 0) break;
        const outcomes = await Promise.all(
          versions.map((version) =>
            this.detectVersion(version.uuid, version.updatedAt),
          ),
        );
        for (const outcome of outcomes) {
          summary.examined++;
          summary[outcome]++;
        }
        after = versions[versions.length - 1]!.uuid;
        if (!programIds)
          this.logger.info(summary, 'Interlace metadata detection progress');
      }
    }
    this.logger[programIds ? 'debug' : 'info'](
      summary,
      'Interlace metadata detection completed',
    );
    return summary;
  }

  private detectVersion(
    id: string,
    updatedAt: number,
  ): Promise<DetectionOutcome> {
    const key = `${id}:${updatedAt}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.queue
      .add(
        async () => {
          try {
            return await this.probeVersion(id, updatedAt);
          } catch {
            // ffprobe errors can contain authenticated URLs and HTTP headers.
            this.logger.warn(
              'Could not detect interlace metadata for version %s',
              id,
            );
            return 'failed' as const;
          }
        },
        { throwOnTimeout: true },
      )
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  private async probeVersion(
    id: string,
    updatedAt: number,
  ): Promise<DetectionOutcome> {
    const version = await this.db
      .selectFrom('programVersion as version')
      .innerJoin('program', 'program.uuid', 'version.programId')
      .select([
        'version.uuid',
        'version.programId',
        'version.updatedAt',
        'version.createdAt',
        'program.mediaSourceId',
      ])
      .where('version.uuid', '=', id)
      .where('version.updatedAt', '=', updatedAt)
      .where('version.scanKind', '=', 'unknown')
      .executeTakeFirst();
    if (!version) return 'skipped';
    const stream = await this.db
      .selectFrom('programMediaStream')
      .select('index')
      .where('programVersionId', '=', id)
      .where('streamKind', '=', 'video')
      .orderBy('index')
      .executeTakeFirst();
    if (!stream) return 'skipped';
    if (!version.mediaSourceId) return 'failed';
    const server = await this.mediaSourceDB.getById(version.mediaSourceId);
    if (!server) return 'failed';
    const file = await this.db
      .selectFrom('programMediaFile')
      .select('path')
      .where('programVersionId', '=', id)
      .orderBy('uuid')
      .executeTakeFirst();
    const externalId =
      server.type === 'local'
        ? undefined
        : await this.db
            .selectFrom('programExternalId')
            .select('externalFilePath')
            .where('programUuid', '=', version.programId)
            .where('sourceType', '=', server.type)
            .where('mediaSourceId', '=', server.uuid)
            .executeTakeFirst();
    const source = await resolveProgramStreamSource(
      server,
      file?.path,
      externalId?.externalFilePath,
    );
    const scanKind = await this.ffmpegInfo.probeScanKind(source, stream.index);
    if (scanKind === 'unknown') return 'inconclusive';
    const result = await this.db
      .updateTable('programVersion')
      .set({ scanKind, updatedAt: Date.now() })
      .where('uuid', '=', id)
      .where('updatedAt', '=', version.updatedAt)
      .where('createdAt', '=', version.createdAt)
      .where('scanKind', '=', 'unknown')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n ? 'updated' : 'skipped';
  }
}
