import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import type { Nilable } from '../types/util.ts';
import { fileExists } from '../util/fsUtil.ts';
import { isNonEmptyString } from '../util/index.ts';
import { trimEnd, trimStart } from 'lodash-es';
import { match } from 'ts-pattern';
import { PathCalculator } from './PathCalculator.ts';
import { HttpStreamSource, type StreamSource } from './types.ts';

export async function resolveProgramStreamSource(
  server: MediaSourceWithRelations,
  potentialFilePath: Nilable<string>,
  serverPath: Nilable<string>,
): Promise<StreamSource> {
  if (isNonEmptyString(potentialFilePath)) {
    if (await fileExists(potentialFilePath)) {
      return {
        type: 'file',
        path: potentialFilePath,
      };
    } else {
      const replacedPath = await PathCalculator.findFirstValidPath(
        potentialFilePath,
        server.replacePaths,
      );
      if (replacedPath) {
        return {
          type: 'file',
          path: replacedPath,
        };
      }
    }
  }

  if (isNonEmptyString(serverPath)) {
    return match(server)
      .with(
        { type: 'plex' },
        (server) =>
          new HttpStreamSource(
            `${trimEnd(server.uri, '/')}/${trimStart(serverPath, '/')}?X-Plex-Token=${
              server.accessToken
            }`,
          ),
      )
      .with(
        { type: 'jellyfin' },
        (server) =>
          new HttpStreamSource(
            `${trimEnd(server.uri, '/')}/Videos/${trimStart(serverPath, '/')}/stream?static=true`,
            {
              'X-Emby-Token': server.accessToken,
            },
          ),
      )
      .with(
        { type: 'emby' },
        (server) =>
          new HttpStreamSource(
            `${trimEnd(server.uri, '/')}/Videos/${trimStart(serverPath, '/')}/stream?X-Emby-Token=${
              server.accessToken
            }&static=true`,
          ),
      )
      .with({ type: 'local' }, () => {
        throw new Error(`Remote paths are not supported for local media`);
      })
      .exhaustive();
  } else {
    throw new Error('Could not resolve stream URL');
  }
}
