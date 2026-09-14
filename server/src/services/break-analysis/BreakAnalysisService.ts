import {
  BreakAnalysisRequestSchema,
  BreakDetectorConfigSchema,
  normalizeBreakDetectorConfig,
  type BreakAnalysisRequest,
  type BreakAnalysisResult,
  type BreakDetectorConfig,
} from '@tunarr/types/schemas';
import { inject, injectable } from 'inversify';
import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import PQueue from 'p-queue';
import { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import { DB } from '../../db/schema/db.ts';
import { DrizzleDBAccess } from '../../db/schema/index.ts';
import { resolveProgramStreamSource } from '../../stream/resolveProgramStreamSource.ts';
import { FileStreamSource, type StreamSource } from '../../stream/types.ts';
import { KEYS } from '../../types/inject.ts';
import { BreakAnalysisRepository } from './BreakAnalysisRepository.ts';
import {
  AnalysisError,
  BreakFeatureExtractor,
  type ExtractionOptions,
} from './BreakFeatureExtractor.ts';
import {
  BREAK_DETECTOR_VERSION,
  breakScanWindow,
  configurationHash,
  evaluateBreaks,
  type Interval,
} from './BreakDetector.ts';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function fingerprintSource(
  source: StreamSource,
  identity: unknown,
  signal?: AbortSignal,
) {
  if (source.type === 'file') {
    const path = await realpath(source.path);
    const info = await stat(path);
    if (!info.isFile()) throw new AnalysisError('not-a-regular-file');
    return {
      fingerprint: hash({
        identity,
        path,
        size: info.size,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
      }),
      verifiable: true,
    };
  }
  if (source.type !== 'http') throw new AnalysisError('unsupported-source');
  const response = await fetch(source.path, {
    method: 'HEAD',
    headers: source.extraHeaders,
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  await response.body?.cancel();
  // Some media servers do not implement HEAD. Such results remain diagnostic only.
  if (!response.ok && response.status !== 405 && response.status !== 501)
    throw new AnalysisError('source-unavailable');
  const etag = response.headers.get('etag');
  const modified = response.headers.get('last-modified');
  const size = response.headers.get('content-length');
  const verifiable =
    response.ok &&
    ((!!etag && !etag.startsWith('W/')) || (!!modified && !!size));
  return { fingerprint: hash({ identity, etag, modified, size }), verifiable };
}

type Input = {
  source: StreamSource;
  runtimeMs: number;
  identity: unknown;
  exclusions: Interval[];
  programId?: string;
  programVersionId?: string;
  mediaFileId?: string;
  seriesId?: string;
};
export type AnalyzeOptions = ExtractionOptions & {
  config: BreakDetectorConfig;
  force?: boolean;
};

@injectable()
export class BreakAnalysisService {
  readonly repository: BreakAnalysisRepository;
  private readonly extractor: BreakFeatureExtractor;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly active = new Map<string, AbortController>();
  private shuttingDown = false;

  constructor(
    @inject(KEYS.Database) private readonly db: Kysely<DB>,
    @inject(KEYS.DrizzleDB) drizzle: DrizzleDBAccess,
    @inject(MediaSourceDB) private readonly sources: MediaSourceDB,
    @inject(KEYS.FFmpegPath) ffmpeg: string,
    @inject(KEYS.FFprobePath) ffprobe: string,
  ) {
    this.repository = new BreakAnalysisRepository(drizzle);
    this.extractor = new BreakFeatureExtractor(ffmpeg, ffprobe);
  }

  private initial(
    input: Partial<Input> & { runtimeMs: number },
    options: AnalyzeOptions,
  ): BreakAnalysisResult {
    return {
      id: randomUUID(),
      programId: input.programId,
      programVersionId: input.programVersionId,
      mediaFileId: input.mediaFileId,
      seriesId: input.seriesId,
      status: 'running',
      createdAt: Date.now(),
      detectorVersion: BREAK_DETECTOR_VERSION,
      configHash: configurationHash(
        options.config,
        options.videoStreamIndex,
        options.audioStreamIndex,
      ),
      config: options.config,
      sourceFingerprint: 'unresolved',
      runtimeMs: input.runtimeMs,
      scanWindow: breakScanWindow(input.runtimeMs, options.config),
      candidates: [],
      usableBreaks: [],
      qualified: false,
      stale: false,
    };
  }

  private async resolveVersion(
    id: string,
    config: BreakDetectorConfig,
  ): Promise<Input> {
    const version = await this.db
      .selectFrom('programVersion as v')
      .innerJoin('program as p', 'p.uuid', 'v.programId')
      .select([
        'v.uuid',
        'v.duration',
        'v.createdAt',
        'v.updatedAt',
        'v.programId',
        'p.mediaSourceId',
        'p.tvShowUuid',
        'p.type',
      ])
      .where('v.uuid', '=', id)
      .executeTakeFirst();
    if (!version || version.type !== 'episode' || !version.mediaSourceId)
      throw new AnalysisError('episode-unavailable');
    const server = await this.sources.getById(version.mediaSourceId);
    if (!server) throw new AnalysisError('source-unavailable');
    const files = await this.db
      .selectFrom('programMediaFile')
      .selectAll()
      .where('programVersionId', '=', id)
      .execute();
    if (files.length !== 1)
      throw new AnalysisError('unsupported-multipart-or-missing-file');
    const file = files[0]!;
    const external =
      server.type === 'local'
        ? undefined
        : await this.db
            .selectFrom('programExternalId')
            .select([
              'externalFilePath',
              'directFilePath',
              'externalKey',
              'updatedAt',
            ])
            .where('programUuid', '=', version.programId)
            .where('mediaSourceId', '=', server.uuid)
            .where('sourceType', '=', server.type)
            .executeTakeFirst();
    const source = await resolveProgramStreamSource(
      server,
      file.path,
      external?.externalFilePath,
    );
    if (source.type === 'http') {
      const versions = await this.db
        .selectFrom('programVersion')
        .select('uuid')
        .where('programId', '=', version.programId)
        .execute();
      if (
        versions.length !== 1 ||
        (external?.directFilePath && external.directFilePath !== file.path)
      ) {
        throw new AnalysisError('ambiguous-remote-version');
      }
    }
    const chapters = await this.db
      .selectFrom('programChapter')
      .selectAll()
      .where('programVersionId', '=', id)
      .execute();
    const margin = config.chapterMarginMs;
    // Generic DVD chapters describe navigation, not whether an ad break is safe.
    // Only semantically identified intro/outro regions are exclusions.
    const exclusions = chapters
      .filter((c) => c.chapterType === 'intro' || c.chapterType === 'outro')
      .map((c) => ({
        startMs: Math.max(0, c.startTime - margin),
        endMs: c.endTime + margin,
      }));
    return {
      source,
      runtimeMs: version.duration,
      programId: version.programId,
      programVersionId: id,
      mediaFileId: file.uuid,
      seriesId: version.tvShowUuid ?? undefined,
      exclusions,
      identity: {
        version,
        file,
        external,
        serverId: server.uuid,
        serverUri: server.uri,
        chapters,
      },
    };
  }

  async analyzeFile(
    path: string,
    runtimeMs: number,
    options: AnalyzeOptions,
    exclusions: Interval[] = [],
  ) {
    const config = normalizeBreakDetectorConfig(
      BreakDetectorConfigSchema.parse(options.config),
    );
    const input: Input = {
      source: new FileStreamSource(path),
      runtimeMs,
      identity: { runtimeMs, exclusions },
      exclusions,
    };
    return this.queue.add(() => this.analyze(input, { ...options, config }), {
      throwOnTimeout: true,
    });
  }

  private async analyze(
    input: Input,
    options: AnalyzeOptions,
  ): Promise<BreakAnalysisResult> {
    let result = this.initial(input, options);
    let claimed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();
    if (this.shuttingDown) controller.abort();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    try {
      const fingerprint = await fingerprintSource(
        input.source,
        input.identity,
        signal,
      );
      result.sourceFingerprint = fingerprint.fingerprint;
      result.stale = !fingerprint.verifiable;
      const deadline = Date.now() + options.timeoutMs;
      while (true) {
        signal.throwIfAborted();
        const claim = this.repository.claim(
          result,
          !!options.force || !fingerprint.verifiable,
        );
        if (claim.kind === 'cached') {
          // A different process may have held the decoder while the source changed.
          const current = input.programVersionId
            ? await this.resolveVersion(input.programVersionId, options.config)
            : input;
          const fresh = await fingerprintSource(
            current.source,
            current.identity,
            signal,
          );
          if (fresh.fingerprint !== result.sourceFingerprint)
            throw new AnalysisError('source-changed');
          signal.throwIfAborted();
          return this.repository.expose(claim.result, !fresh.verifiable);
        }
        if (claim.kind === 'claimed') {
          claimed = true;
          break;
        }
        if (Date.now() >= deadline) throw new AnalysisError('queue-timeout');
        await delay(1000, undefined, { signal });
      }
      heartbeat = setInterval(() => {
        try {
          if (!this.repository.heartbeat(result.id)) controller.abort();
        } catch {
          controller.abort();
        }
      }, 10000);
      this.active.set(result.id, controller);
      const { features, probe } = await this.extractor.extract(
        input.source,
        input.runtimeMs,
        options.config,
        { ...options, signal, timeoutMs: Math.max(1, deadline - Date.now()) },
      );
      result.videoStreamIndex = probe?.video.index;
      result.audioStreamIndex = probe?.audio.index;
      result.candidates = evaluateBreaks(
        features,
        input.runtimeMs,
        options.config,
        input.exclusions,
      );
      const current = input.programVersionId
        ? await this.resolveVersion(input.programVersionId, options.config)
        : input;
      const after = await fingerprintSource(
        current.source,
        current.identity,
        signal,
      );
      if (after.fingerprint !== result.sourceFingerprint)
        throw new AnalysisError('source-changed');
      signal.throwIfAborted();
      result.status = 'completed';
      result.finishedAt = Date.now();
      if (!this.repository.finish(result))
        throw new AnalysisError('analysis-claim-lost');
      return this.repository.expose(result, result.stale);
    } catch (error) {
      result = {
        ...result,
        status: signal.aborted ? 'interrupted' : 'failed',
        finishedAt: Date.now(),
        usableBreaks: [],
        error: signal.aborted
          ? 'cancelled'
          : error instanceof AnalysisError
            ? error.code
            : 'analysis-failed',
      };
      if (claimed) this.repository.finish(result);
      else this.repository.recordFailure(result);
      return result;
    } finally {
      clearInterval(heartbeat);
      this.active.delete(result.id);
    }
  }

  cancel(id: string) {
    const controller = this.active.get(id);
    controller?.abort();
    return !!controller;
  }

  cancelAll() {
    this.shuttingDown = true;
    for (const controller of this.active.values()) controller.abort();
  }

  async batch(rawRequest: BreakAnalysisRequest, signal?: AbortSignal) {
    const request = BreakAnalysisRequestSchema.parse(rawRequest);
    const results: BreakAnalysisResult[] = [];
    let after = '';
    while (!signal?.aborted && !this.shuttingDown) {
      let query = this.db
        .selectFrom('programVersion as v')
        .innerJoin('program as p', 'p.uuid', 'v.programId')
        .select(['v.uuid', 'v.duration', 'v.programId'])
        .where('p.type', '=', 'episode')
        .where('v.uuid', '>', after)
        .orderBy('v.uuid')
        .limit(100);
      if (request.programIds)
        query = query.where('p.uuid', 'in', request.programIds);
      if (request.seriesId)
        query = query.where('p.tvShowUuid', '=', request.seriesId);
      if (request.libraryId)
        query = query.where('p.libraryId', '=', request.libraryId);
      const versions = await query.execute();
      if (!versions.length) break;
      for (const version of versions) {
        if (signal?.aborted || this.shuttingDown) break;
        const result = await this.queue.add(
          async () => {
            let input: Input;
            try {
              input = await this.resolveVersion(version.uuid, request.config);
            } catch (error) {
              const failed: BreakAnalysisResult = {
                ...this.initial(
                  {
                    runtimeMs: version.duration,
                    programId: version.programId,
                    programVersionId: version.uuid,
                  },
                  request,
                ),
                status: 'skipped',
                finishedAt: Date.now(),
                error:
                  error instanceof AnalysisError
                    ? error.code
                    : 'source-unavailable',
              };
              this.repository.recordFailure(failed);
              return failed;
            }
            return this.analyze(input, { ...request, signal });
          },
          { throwOnTimeout: true },
        );
        results.push(result);
      }
      after = versions.at(-1)!.uuid;
    }
    return results;
  }

  async history(programId: string, limit = 100, offset = 0) {
    const results = this.repository.history(programId, limit, offset);
    const fingerprints = new Map<string, string | undefined>();
    for (const result of results) {
      const key = `${result.programVersionId}:${result.configHash}`;
      if (!fingerprints.has(key)) {
        try {
          const current = await this.resolveVersion(
            result.programVersionId!,
            result.config,
          );
          const source = await fingerprintSource(
            current.source,
            current.identity,
          );
          fingerprints.set(
            key,
            source.verifiable ? source.fingerprint : undefined,
          );
        } catch {
          fingerprints.set(key, undefined);
        }
      }
    }
    return results.map((r) =>
      this.repository.expose(
        r,
        fingerprints.get(`${r.programVersionId}:${r.configHash}`) !==
          r.sourceFingerprint,
      ),
    );
  }
}
