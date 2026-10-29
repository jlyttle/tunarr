import {
  SmartCollectionTimeSlot,
  StrictTimeSlotScheduleSchema,
} from '@tunarr/types/api';
import { describe, expect, test } from 'vitest';
import { artistKeys, tierOf } from './artistKeys.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';

describe('artistKeys', () => {
  test.each([
    ['Dr. Dre feat. Snoop Dogg', ['dr. dre', 'snoop dogg']],
    ['Puff Daddy & the Family', ['puff daddy', 'family']],
    ['The The', ['the']],
    ['Björk', ['bjork']],
    ['A ft. B featuring C x D and E', ['a', 'b', 'c', 'd', 'e']],
    ['Earth, Wind  &  Fire', ['earth', 'wind', 'fire']],
    ['Sandy and Max', ['sandy', 'max']],
    ['Xander Brand', ['xander brand']],
    ['Anderson', ['anderson']],
    ['Foo & Foo', ['foo']],
    ['Foo, ', ['foo']],
    ['Foo & ...', ['foo']],
  ])('%s', (input, expected) => {
    expect(artistKeys(input)).toEqual(expected);
  });

  test('null, undefined and empty give no keys', () => {
    expect(artistKeys(null)).toEqual([]);
    expect(artistKeys(undefined)).toEqual([]);
    expect(artistKeys('  ')).toEqual([]);
  });
});

describe('tierOf', () => {
  test('reads tier tags, defaulting to light', () => {
    expect(tierOf(['tier:heavy'])).toBe('heavy');
    expect(tierOf(['x', 'tier:medium'])).toBe('medium');
    expect(tierOf(['tier:light'])).toBe('light');
    expect(tierOf([])).toBe('light');
    expect(tierOf(['tier:bogus'])).toBe('light');
  });
});

describe('weighted_rotation slot schema', () => {
  const base = {
    startTime: 0,
    id,
    order: 'weighted_rotation',
    direction: 'asc',
  };

  test('smart-collection slot accepts it with partial rotation', () => {
    const result = SmartCollectionTimeSlot.safeParse({
      ...base,
      type: 'smart-collection',
      smartCollectionId: id,
      rotation: { tierWeights: { heavy: 5 }, songGapMs: 1000 },
    });
    expect(result.success).toBe(true);
  });

  test('show slot rejects it', () => {
    const schedule = (order: string) => ({
      type: 'time',
      flexPreference: 'end',
      latenessMs: 0,
      maxDays: 1,
      padMs: 1,
      period: 'day',
      slots: [{ ...base, order, type: 'show', showId: 'x' }],
      timeZoneOffset: 0,
      sortTempOrder: 'x',
    });
    expect(
      StrictTimeSlotScheduleSchema.safeParse(schedule('shuffle')).success,
    ).toBe(true);
    expect(
      StrictTimeSlotScheduleSchema.safeParse(schedule('weighted_rotation'))
        .success,
    ).toBe(false);
  });
});
