import { BreakAnalysisRequestSchema } from '@tunarr/types/schemas';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeArtifact } from '../../cli/BreakAnalysisCommand.ts';
import { evaluationFixture } from '../../testing/BreakAnalysisFixtures.ts';
import { breakAnalysisApi } from '../../api/breakAnalysisApi.ts';
import { container } from '../../container.ts';
import { AnalyzeEpisodeBreaksTask } from '../../tasks/AnalyzeEpisodeBreaksTask.ts';
import { TaskRegistry } from '../../tasks/TaskRegistry.ts';
import { BreakAnalysisService } from './BreakAnalysisService.ts';

describe('offline task and API integration', () => {
  afterEach(() => vi.restoreAllMocks());
  test('output paths cannot overwrite media, but existing analysis artifacts can be refreshed', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'tunarr-break-output-'),
    );
    try {
      const media = path.join(directory, 'episode.mkv');
      await writeFile(media, 'original media bytes');
      const result = JSON.stringify(evaluationFixture().episodes[0]!.result);
      await expect(writeArtifact(media, result)).rejects.toThrow(
        'Refusing to overwrite',
      );
      expect(await readFile(media, 'utf8')).toBe('original media bytes');
      const artifact = path.join(directory, 'analysis.json');
      await writeArtifact(artifact, result);
      await writeArtifact(artifact, result);
      expect(await readFile(artifact, 'utf8')).toBe(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('requires explicit bounded selections and registers the task', () => {
    expect(BreakAnalysisRequestSchema.safeParse({}).success).toBe(false);
    expect(
      BreakAnalysisRequestSchema.safeParse({
        allEpisodes: true,
        seriesId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      BreakAnalysisRequestSchema.safeParse({ allEpisodes: true, threads: 100 })
        .success,
    ).toBe(false);
    expect(TaskRegistry.getTask(AnalyzeEpisodeBreaksTask.name)?.schema).toBe(
      BreakAnalysisRequestSchema,
    );
  });
  test('history validates inputs and cancellation delegates without triggering analysis', async () => {
    const service = {
      history: vi.fn().mockResolvedValue([]),
      cancel: vi.fn().mockReturnValue(true),
      cancelAll: vi.fn(),
      batch: vi.fn(),
    };
    vi.spyOn(container, 'get').mockImplementation((id) => {
      if (id === BreakAnalysisService) return service;
      throw new Error('Unexpected dependency');
    });
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(breakAnalysisApi);
    try {
      const id = '00000000-0000-4000-8000-000000000001';
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/programs/${id}/break-analysis?limit=2&offset=1`,
          })
        ).json(),
      ).toEqual([]);
      expect(service.history).toHaveBeenCalledWith(id, 2, 1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/programs/${id}/break-analysis?limit=1000`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({ method: 'DELETE', url: `/break-analysis/${id}` })
        ).json(),
      ).toEqual({ cancelled: true });
      expect(service.cancel).toHaveBeenCalledWith(id);
      expect(service.batch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(service.cancelAll).toHaveBeenCalledOnce();
  });
});
