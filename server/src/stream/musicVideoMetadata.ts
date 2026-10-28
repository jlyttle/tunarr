import type { ProgramOrmWithExternalIds } from '@/db/schema/derivedTypes.js';

export type MusicVideoMetadata = {
  artist?: string;
  title: string;
  album?: string;
  label?: string;
  director?: string;
  tags: string[];
};

function nonEmpty(value: string | null | undefined) {
  return value ? value : undefined;
}

const GainTagPattern = /^gain:([+-]?\d+(?:\.\d+)?)$/;

export function parseGainTag(tags: string[]): number | null {
  for (const tag of tags) {
    const match = GainTagPattern.exec(tag);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export function programGainDb(
  program: ProgramOrmWithExternalIds,
): number | null {
  return parseGainTag(musicVideoMetadata(program)?.tags ?? []);
}

export function musicVideoMetadata(
  program: ProgramOrmWithExternalIds,
): MusicVideoMetadata | null {
  if (program.type !== 'music_video') {
    return null;
  }

  const artist = nonEmpty(program.artistName);
  const album = nonEmpty(program.albumName);
  const label = nonEmpty(program.studios?.[0]?.studio.name);
  const director = nonEmpty(
    program.credits?.find((credit) => credit.type === 'director')?.name,
  );

  return {
    ...(artist && { artist }),
    title: program.title,
    ...(album && { album }),
    ...(label && { label }),
    ...(director && { director }),
    tags: (program.tags ?? []).map((t) => t.tag.tag).filter(Boolean),
  };
}
