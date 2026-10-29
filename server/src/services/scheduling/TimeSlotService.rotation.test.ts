import { randomUUID } from 'node:crypto';
import type { CondensedChannelProgram } from '@tunarr/types';
import type { TimeSlot, TimeSlotSchedule } from '@tunarr/types/api';
import dayjs from '@/util/dayjs.js';
import { MersenneTwister19937, Random } from 'random-js';
import { describe, expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import { artistKeys } from './rotation/artistKeys.ts';
import { RotationState } from './rotation/RotationState.ts';
import type { SlotSchedulerProgram } from './slotSchedulerUtil.js';
import { createProgramMap, createSlotIterators } from './slotSchedulerUtil.js';
import { scheduleTimeSlots } from './TimeSlotService.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Local midnight, so slot offsets line up in every time zone.
const START = dayjs('2026-01-05');
const SEED = [7, 11, 13, 17];

function makeVideo(
  uuid: string,
  artistName: string,
  collections: string[],
): SlotSchedulerProgram {
  return {
    ...createFakeProgramOrm({
      uuid,
      title: uuid,
      type: 'music_video',
      duration: 4 * MINUTE,
      artistName,
      tags: [],
    }),
    parentFillerLists: [],
    parentCustomShows: [],
    parentSmartCollections: collections,
  };
}

function rotationSlot(smartCollectionId: string, startTime: number): TimeSlot {
  return {
    id: randomUUID(),
    startTime,
    type: 'smart-collection',
    smartCollectionId,
    order: 'weighted_rotation',
    direction: 'asc',
  };
}

function flexSlot(startTime: number): TimeSlot {
  return { id: randomUUID(), startTime, type: 'flex' };
}

function daySchedule(slots: TimeSlot[], maxDays = 3): TimeSlotSchedule {
  return {
    type: 'time',
    flexPreference: 'end',
    maxDays,
    padMs: MINUTE,
    slots,
    period: 'day',
    latenessMs: 0,
    overflow: { type: 'duration', maxMs: 0 },
    timeZoneOffset: 0,
  };
}

type Placement = { id: string; at: number };

function placements(lineup: CondensedChannelProgram[]): Placement[] {
  const result: Placement[] = [];
  let at = +START;
  for (const item of lineup) {
    if (item.type === 'content' && item.id !== undefined) {
      result.push({ id: item.id, at });
    }
    at += item.duration;
  }
  return result;
}

function minGapBetweenSameKey(
  placed: Placement[],
  keysOf: (p: Placement) => string[],
): number {
  const lastAt = new Map<string, number>();
  let minGap = Infinity;
  for (const p of placed) {
    for (const key of keysOf(p)) {
      const prev = lastAt.get(key);
      if (prev !== undefined) {
        minGap = Math.min(minGap, p.at - prev);
      }
      lastAt.set(key, p.at);
    }
  }
  return minGap;
}

describe('weighted rotation in the time-slot scheduler', () => {
  const collectionX = randomUUID();
  const collectionY = randomUUID();

  test('two weighted slots sharing a video record one recency', async () => {
    const programs = [
      makeVideo('shared', 'Shared Artist', [collectionX, collectionY]),
      ...Array.from({ length: 20 }, (_, i) =>
        makeVideo(`x${i}`, `X Artist ${i}`, [collectionX]),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeVideo(`y${i}`, `Y Artist ${i}`, [collectionY]),
      ),
    ];
    const schedule = daySchedule([
      rotationSlot(collectionX, 0),
      rotationSlot(collectionY, HOUR),
      flexSlot(2 * HOUR),
    ]);

    const result = await scheduleTimeSlots(schedule, programs, SEED, 0, START);
    const shared = placements(result.lineup).filter((p) => p.id === 'shared');

    expect(shared.length).toBeGreaterThan(1);
    expect(minGapBetweenSameKey(shared, (p) => [p.id])).toBeGreaterThanOrEqual(
      DAY,
    );
  });

  test('artist gap holds across a slot boundary', async () => {
    const artistOf = new Map<string, string>();
    const programs = Array.from({ length: 20 }, (_, i) => {
      const artist = `Artist ${i}`;
      artistOf.set(`x${i}`, artist);
      artistOf.set(`y${i}`, artist);
      return [
        makeVideo(`x${i}`, artist, [collectionX]),
        makeVideo(`y${i}`, artist, [collectionY]),
      ];
    }).flat();
    const schedule = daySchedule([
      rotationSlot(collectionX, 0),
      rotationSlot(collectionY, HOUR),
      flexSlot(2 * HOUR),
    ]);

    const result = await scheduleTimeSlots(schedule, programs, SEED, 0, START);
    const placed = placements(result.lineup);

    expect(placed.length).toBeGreaterThan(0);
    expect(
      minGapBetweenSameKey(placed, (p) => artistKeys(artistOf.get(p.id))),
    ).toBeGreaterThanOrEqual(HOUR);
  });

  test('same seed produces an identical lineup', async () => {
    const programs = Array.from({ length: 40 }, (_, i) =>
      makeVideo(`v${i}`, `Artist ${i % 12}`, [collectionX]),
    );
    const schedule = () =>
      daySchedule([rotationSlot(collectionX, 0), flexSlot(6 * HOUR)], 2);

    const first = await scheduleTimeSlots(schedule(), programs, SEED, 0, START);
    const second = await scheduleTimeSlots(
      schedule(),
      programs,
      SEED,
      0,
      START,
    );

    expect(placements(first.lineup).length).toBeGreaterThan(0);
    expect(second.lineup).toEqual(first.lineup);
  });

  test('a mixed link group records airings at the placement time', () => {
    const group = randomUUID();
    const programs = Array.from({ length: 5 }, (_, i) =>
      makeVideo(`v${i}`, `Artist ${i}`, [collectionX]),
    );
    const continueSlot = {
      ...rotationSlot(collectionX, 0),
      iterationGroup: group,
      linkMode: 'continue' as const,
    };
    const rerunSlot = {
      ...rotationSlot(collectionX, HOUR),
      iterationGroup: group,
      linkMode: 'rerun' as const,
    };
    const state = new RotationState();
    const { iterators } = createSlotIterators(
      [continueSlot, rerunSlot],
      createProgramMap(programs),
      new Random(MersenneTwister19937.seed(1)),
      state,
    );
    const iterator = iterators.get(continueSlot.id);
    if (iterator === undefined) {
      throw new Error('continue slot has no iterator');
    }
    const placedAt = +START + 3 * HOUR;

    const program = iterator.current({
      slotDuration: HOUR,
      timeCursor: placedAt,
    });
    iterator.next();

    expect(program?.type).toBe('content');
    const id = program?.type === 'content' ? program.id : undefined;
    expect(id).toBeDefined();
    expect(state.songLastAired.get(id ?? '')).toBe(placedAt);
  });
});

describe('shuffle-only schedules are unchanged by weighted rotation', () => {
  test('smart-collection and movie shuffle slots keep their golden lineup', async () => {
    const collection = '7a0f8c3e-5b8b-4d38-9d0e-6f2b1c9e4a11';
    const programs = [
      ...Array.from({ length: 12 }, (_, i) =>
        makeVideo(`sc${i}`, `Artist ${i}`, [collection]),
      ),
      ...Array.from({ length: 6 }, (_, i) => ({
        ...createFakeProgramOrm({
          uuid: `movie${i}`,
          title: `Movie ${i}`,
          type: 'movie',
          duration: 90 * MINUTE,
        }),
        parentFillerLists: [],
        parentCustomShows: [],
        parentSmartCollections: [],
      })),
    ];
    const schedule = daySchedule(
      [
        {
          id: 'c0a8e8b4-1d4e-4b0a-8f7d-2f4f7f0d6e01',
          startTime: 0,
          type: 'smart-collection',
          smartCollectionId: collection,
          order: 'shuffle',
          direction: 'asc',
        },
        {
          id: 'c0a8e8b4-1d4e-4b0a-8f7d-2f4f7f0d6e02',
          startTime: HOUR,
          type: 'movie',
          order: 'shuffle',
          direction: 'asc',
        },
      ],
      1,
    );

    const result = await scheduleTimeSlots(schedule, programs, SEED, 0, START);

    expect(
      result.lineup.map((p) =>
        p.type === 'content' ? p.id : `${p.type}:${p.duration}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "sc11",
        "sc8",
        "sc3",
        "sc10",
        "sc4",
        "sc9",
        "sc1",
        "sc5",
        "sc6",
        "sc7",
        "sc2",
        "sc0",
        "sc8",
        "sc6",
        "sc4",
        "sc3",
        "sc9",
        "sc0",
        "movie2",
        "movie3",
        "sc5",
        "sc1",
        "sc7",
        "sc11",
        "sc6",
        "movie0",
        "movie5",
        "sc10",
        "sc8",
        "sc4",
        "movie1",
        "movie4",
        "sc2",
        "movie2",
        "sc0",
        "movie1",
        "sc7",
        "sc4",
        "sc10",
        "movie5",
        "sc5",
        "sc1",
        "sc6",
        "sc3",
        "sc11",
        "sc9",
        "movie4",
        "sc2",
        "movie3",
        "sc8",
        "movie0",
        "sc11",
        "sc5",
        "sc6",
        "sc1",
        "sc2",
        "sc9",
        "movie4",
        "sc10",
        "flex:5160000",
        "sc9",
        "sc2",
        "sc10",
        "sc1",
        "sc11",
        "sc5",
        "sc0",
        "sc3",
        "sc7",
        "sc7",
        "sc3",
        "sc9",
        "sc11",
        "sc8",
        "sc1",
        "movie5",
        "sc0",
        "sc3",
        "sc4",
        "movie3",
        "movie0",
        "sc8",
        "sc7",
        "movie1",
        "movie2",
        "sc6",
        "sc10",
        "sc5",
        "sc2",
        "sc9",
        "sc11",
        "movie2",
        "sc0",
        "sc1",
        "movie5",
        "movie4",
        "movie0",
        "movie3",
        "sc4",
        "sc7",
        "sc3",
        "sc8",
        "movie1",
        "movie4",
        "movie0",
        "sc7",
        "movie5",
        "flex:2880000",
      ]
    `);
  });
});
