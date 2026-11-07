import { tag } from '@tunarr/types';
import { describe, expect, test } from 'vitest';
import type { MediaSourceId } from '../../db/schema/base.js';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import { canMaterialize } from './SlotSchedulerHelper.ts';

const mediaSourceId = tag<MediaSourceId>('source-1');

describe('canMaterialize', () => {
  test('accepts a program with a media source and a library', () => {
    const program = createFakeProgramOrm({
      mediaSourceId,
      libraryId: 'library-1',
    });
    expect(canMaterialize(program)).toBe(true);
  });

  // A program the lineup cannot materialize is dropped from the saved lineup
  // along with its duration, so everything scheduled after it airs early.
  test('rejects a program without a library', () => {
    const program = createFakeProgramOrm({ mediaSourceId, libraryId: null });
    expect(canMaterialize(program)).toBe(false);
  });

  test('rejects a program without a media source', () => {
    const program = createFakeProgramOrm({
      mediaSourceId: null,
      libraryId: 'library-1',
    });
    expect(canMaterialize(program)).toBe(false);
  });
});
