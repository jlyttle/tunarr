import { BreakAnalysisResultSchema } from '@tunarr/types/schemas';
import { z } from 'zod/v4';
import { container } from '../container.ts';
import { BreakAnalysisService } from '../services/break-analysis/BreakAnalysisService.ts';
import type { RouterPluginAsyncCallback } from '../types/serverType.ts';

export const breakAnalysisApi: RouterPluginAsyncCallback = (fastify) => {
  fastify.addHook('onClose', (_instance, done) => {
    container.get(BreakAnalysisService).cancelAll();
    done();
  });
  fastify.delete(
    '/break-analysis/:id',
    {
      schema: {
        tags: ['Programming'],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ cancelled: z.boolean() }) },
      },
    },
    (request) => ({
      cancelled: container.get(BreakAnalysisService).cancel(request.params.id),
    }),
  );
  fastify.get(
    '/programs/:id/break-analysis',
    {
      schema: {
        tags: ['Programming'],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().nonnegative().default(0),
        }),
        response: { 200: z.array(BreakAnalysisResultSchema) },
      },
    },
    async (request) =>
      container
        .get(BreakAnalysisService)
        .history(request.params.id, request.query.limit, request.query.offset),
  );
  return Promise.resolve();
};
