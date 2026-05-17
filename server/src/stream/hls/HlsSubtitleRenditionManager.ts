import { ChildProcessHelper } from '@/util/ChildProcessHelper.js';
import { fileExists } from '@/util/fsUtil.js';
import { isNonEmptyString } from '@/util/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HlsSubtitleRendition } from './HlsMasterPlaylist.ts';

export type HlsSubtitleRegistration = {
  sourcePath: string;
  codec: string;
  language?: string;
  name?: string;
  startTimeMs?: number;
  durationMs: number;
  ffmpegPath: string;
};

type SubtitleSegment = {
  filename: string;
  durationSeconds: number;
};

export class HlsSubtitleRenditionManager {
  static readonly PlaylistName = 'subtitles.m3u8';
  private segments: SubtitleSegment[] = [];
  private language = 'und';
  private name = 'Subtitles';

  constructor(
    private workingDirectory: string,
    private baseStreamUrl: string,
  ) {}

  get hasRenditions(): boolean {
    return this.segments.length > 0;
  }

  get rendition(): HlsSubtitleRendition {
    return {
      groupId: 'subs',
      language: this.language,
      name: this.name,
      playlistUri: `${this.baseStreamUrl}${HlsSubtitleRenditionManager.PlaylistName}`,
      default: true,
    };
  }

  async register(registration: HlsSubtitleRegistration): Promise<void> {
    if (!isNonEmptyString(registration.sourcePath)) {
      return;
    }

    const filename = `subtitles${this.segments.length
      .toString()
      .padStart(6, '0')}.vtt`;
    const outputPath = path.join(this.workingDirectory, filename);

    this.language = registration.language ?? this.language;
    this.name = registration.name ?? this.name;
    await this.writeWebVtt(registration, outputPath);

    this.segments.push({
      filename,
      durationSeconds: Math.max(1, registration.durationMs / 1000),
    });
    await this.writePlaylist();
  }

  private async writeWebVtt(
    registration: HlsSubtitleRegistration,
    outputPath: string,
  ) {
    if (
      registration.codec.toLowerCase() === 'webvtt' &&
      !registration.sourcePath.startsWith('http') &&
      !registration.startTimeMs
    ) {
      await fs.copyFile(registration.sourcePath, outputPath);
      return;
    }

    await new ChildProcessHelper().getStdout(
      registration.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'warning',
        '-y',
        ...(registration.startTimeMs && registration.startTimeMs > 0
          ? ['-ss', `${registration.startTimeMs}ms`]
          : []),
        '-i',
        registration.sourcePath,
        '-c:s',
        'webvtt',
        outputPath,
      ],
      { swallowError: false },
    );

    if (!(await fileExists(outputPath))) {
      throw new Error(`FFmpeg did not create subtitle segment ${outputPath}`);
    }
  }

  private async writePlaylist() {
    const targetDuration = Math.ceil(
      Math.max(...this.segments.map((segment) => segment.durationSeconds), 1),
    );
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    for (const [idx, segment] of this.segments.entries()) {
      if (idx > 0) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      lines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
      lines.push(segment.filename);
    }

    await fs.writeFile(
      path.join(this.workingDirectory, HlsSubtitleRenditionManager.PlaylistName),
      `${lines.join('\n')}\n`,
    );
  }
}
