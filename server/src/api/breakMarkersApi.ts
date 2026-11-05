import {
  BreakMarkerFileSchema,
  BreakMarkerImportResultSchema,
} from '@tunarr/types/api';
import { container } from '../container.ts';
import { BreakMarkerImporter } from '../services/break-markers/BreakMarkerImporter.ts';
import type { RouterPluginAsyncCallback } from '../types/serverType.ts';

export const breakMarkersApi: RouterPluginAsyncCallback = (fastify) => {
  fastify.post(
    '/break-markers',
    {
      schema: {
        tags: ['Programming'],
        body: BreakMarkerFileSchema,
        response: { 200: BreakMarkerImportResultSchema },
      },
    },
    (request) => container.get(BreakMarkerImporter).import(request.body),
  );
  return Promise.resolve();
};
