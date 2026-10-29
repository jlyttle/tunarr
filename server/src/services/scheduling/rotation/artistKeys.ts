import type { RotationTier } from '@tunarr/types/api';

const TIER_TAG_PREFIX = 'tier:';
const SEPARATOR = /\s*,\s*|\s+(?:&|feat\.|ft\.|featuring|x|and)\s+/i;

function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingThe(name: string): string {
  return name.replace(/^the\s+/, '');
}

function stripTrailingPunctuation(name: string): string {
  return name.replace(/[\s.,;:!?-]+$/, '');
}

function hasContent(name: string): boolean {
  return /[\p{L}\p{N}]/u.test(name);
}

export function artistKeys(artistName: string | null | undefined): string[] {
  if (!artistName) {
    return [];
  }
  const keys = normalize(artistName)
    .split(SEPARATOR)
    .map((fragment) => stripTrailingPunctuation(fragment.trim()))
    .map(stripLeadingThe)
    .filter(hasContent);
  return [...new Set(keys)];
}

export function tierOf(tags: string[]): RotationTier {
  for (const tag of tags) {
    const name = tag.trim().toLowerCase();
    if (name === `${TIER_TAG_PREFIX}heavy`) return 'heavy';
    if (name === `${TIER_TAG_PREFIX}medium`) return 'medium';
  }
  return 'light';
}
