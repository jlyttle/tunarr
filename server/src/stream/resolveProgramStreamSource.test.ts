import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import { fileExists } from '../util/fsUtil.ts';
import { PathCalculator } from './PathCalculator.ts';
import { resolveProgramStreamSource } from './resolveProgramStreamSource.ts';

vi.mock('../util/fsUtil.ts', () => ({ fileExists: vi.fn() }));
vi.mock('./PathCalculator.ts', () => ({
  PathCalculator: { findFirstValidPath: vi.fn() },
}));
afterEach(() => vi.resetAllMocks());
const server = {
  type: 'plex',
  uri: 'http://plex',
  accessToken: 'secret',
  replacePaths: [],
} as unknown as MediaSourceWithRelations;

describe('shared scan/playback source resolution', () => {
  test('prefers an accessible local path to a remote URL', async () => {
    vi.mocked(fileExists).mockResolvedValue(true);
    expect(
      await resolveProgramStreamSource(server, '/episode.mkv', '/remote'),
    ).toEqual({ type: 'file', path: '/episode.mkv' });
    expect(PathCalculator.findFirstValidPath).not.toHaveBeenCalled();
  });
  test('uses configured path replacements', async () => {
    vi.mocked(fileExists).mockResolvedValue(false);
    vi.mocked(PathCalculator.findFirstValidPath).mockResolvedValue(
      '/mapped/episode.mkv',
    );
    expect(
      await resolveProgramStreamSource(
        server,
        '/source/episode.mkv',
        '/remote',
      ),
    ).toEqual({ type: 'file', path: '/mapped/episode.mkv' });
    expect(PathCalculator.findFirstValidPath).toHaveBeenCalledWith(
      '/source/episode.mkv',
      server.replacePaths,
    );
  });
  test('reports missing local sources without using a remote URL', async () => {
    vi.mocked(fileExists).mockResolvedValue(false);
    await expect(
      resolveProgramStreamSource(
        { ...server, type: 'local' },
        '/missing',
        undefined,
      ),
    ).rejects.toThrow();
  });
});
