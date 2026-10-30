import { MersenneTwister19937, Random } from 'random-js';
import { describe, expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../../testing/fakes/entityCreators.ts';
import type { SlotSchedulerProgram } from '../slotSchedulerUtil.ts';
import { artistKeys } from './artistKeys.ts';
import { resolveRotationParams } from './resolveRotationParams.ts';
import { RotationState } from './RotationState.ts';
import {
  recoveryFactor,
  WeightedRotationProgramIterator,
} from './WeightedRotationProgramIterator.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 1);

type FakeSpec = { artist: string; tier?: string; duration?: number };

function makeProgram(i: number, spec: FakeSpec): SlotSchedulerProgram {
  const uuid = `p${String(i).padStart(4, '0')}`;
  return {
    ...createFakeProgramOrm({
      uuid,
      title: `Song ${i}`,
      type: 'music_video',
      duration: spec.duration ?? 4 * MINUTE,
      artistName: spec.artist,
      tags: spec.tier
        ? [
            {
              tagId: `t-${spec.tier}`,
              programId: uuid,
              groupingId: null,
              source: 'media',
              tag: { uuid: `t-${spec.tier}`, tag: `tier:${spec.tier}` },
            },
          ]
        : [],
    }),
    parentFillerLists: [],
    parentCustomShows: [],
    parentSmartCollections: [],
  };
}

function makePool(
  count: number,
  artistCount: number,
  tierOfIndex: (i: number) => string | undefined = () => undefined,
): SlotSchedulerProgram[] {
  return Array.from({ length: count }, (_, i) =>
    makeProgram(i, {
      artist: `Artist ${i % artistCount}`,
      tier: tierOfIndex(i),
    }),
  );
}

type Placement = { id: string; at: number };

function makeIterator(
  programs: SlotSchedulerProgram[],
  seed = 42,
  params = resolveRotationParams(),
) {
  return new WeightedRotationProgramIterator(
    programs,
    new RotationState(),
    new Random(MersenneTwister19937.seed(seed)),
    params,
  );
}

function simulate(
  iterator: WeightedRotationProgramIterator,
  durationMs: number,
): Placement[] {
  const placements: Placement[] = [];
  let timeCursor = START;
  while (timeCursor < START + durationMs) {
    const program = iterator.current({ slotDuration: HOUR, timeCursor });
    if (!program) {
      throw new Error('iterator returned null');
    }
    placements.push({ id: program.id, at: timeCursor });
    iterator.next();
    timeCursor += program.duration;
  }
  return placements;
}

function artistById(programs: SlotSchedulerProgram[]) {
  return new Map(programs.map((p) => [p.uuid, artistKeys(p.artistName)]));
}

describe('WeightedRotationProgramIterator', () => {
  test('same seed gives the same sequence; a different seed does not', () => {
    const programs = makePool(100, 20);
    const run = (seed: number) =>
      simulate(makeIterator(programs, seed), 6 * HOUR).map((p) => p.id);
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  test('no artist repeats within 60 minutes and no song within 24 hours', () => {
    const programs = makePool(400, 40);
    const artists = artistById(programs);
    const placements = simulate(makeIterator(programs), DAY);
    const lastArtist = new Map<string, number>();
    const lastSong = new Map<string, number>();
    for (const { id, at } of placements) {
      const prevSong = lastSong.get(id);
      if (prevSong !== undefined) {
        expect(at - prevSong).toBeGreaterThanOrEqual(DAY);
      }
      lastSong.set(id, at);
      for (const key of artists.get(id) ?? []) {
        const prev = lastArtist.get(key);
        if (prev !== undefined) {
          expect(at - prev).toBeGreaterThanOrEqual(HOUR);
        }
        lastArtist.set(key, at);
      }
    }
    expect(placements.length).toBe(360);
  });

  test('a collaboration blocks every artist it names', () => {
    const programs = [
      makeProgram(0, { artist: 'Dr. Dre feat. Snoop Dogg' }),
      makeProgram(1, { artist: 'Snoop Dogg' }),
      ...Array.from({ length: 30 }, (_, i) =>
        makeProgram(i + 2, { artist: `Other ${i}` }),
      ),
    ];
    const placements = simulate(makeIterator(programs, 3), 2 * HOUR);
    const at = (id: string) =>
      placements.filter((p) => p.id === id).map((p) => p.at);
    for (const a of at('p0000')) {
      for (const b of at('p0001')) {
        expect(Math.abs(a - b)).toBeGreaterThanOrEqual(HOUR);
      }
    }
  });

  test('heavy items air 1.5x to 4x as often as light items over a week', () => {
    const programs = makePool(600, 60, (i) =>
      i % 3 === 0 ? 'heavy' : i % 3 === 1 ? 'medium' : undefined,
    );
    const placements = simulate(makeIterator(programs), 7 * DAY);
    const counts = new Map<string, number>();
    for (const { id } of placements) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const playsFor = (remainder: number) =>
      programs
        .filter((_, i) => i % 3 === remainder)
        .reduce((acc, p) => acc + (counts.get(p.uuid) ?? 0), 0);
    const ratio = playsFor(0) / playsFor(2);
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(4);
  });

  test('an item that just aired has near-zero weight', () => {
    expect(recoveryFactor(MINUTE, 10 * DAY)).toBeLessThan(1e-6);
    expect(recoveryFactor(5 * DAY, 10 * DAY)).toBeCloseTo(0.25);
    expect(recoveryFactor(20 * DAY, 10 * DAY)).toBe(1);
    expect(recoveryFactor(undefined, 10 * DAY)).toBe(1);

    const params = resolveRotationParams({ songGapMs: 0, artistGapMs: 0 });
    for (let seed = 0; seed < 50; seed++) {
      const programs = [
        makeProgram(0, { artist: 'A' }),
        makeProgram(1, { artist: 'B' }),
      ];
      const iterator = makeIterator(programs, seed, params);
      const first = iterator.current({ slotDuration: HOUR, timeCursor: START });
      iterator.next();
      const second = iterator.current({
        slotDuration: HOUR,
        timeCursor: START + 4 * MINUTE,
      });
      expect(second?.id).not.toBe(first?.id);
    }
  });

  test('a tiny pool of one artist completes and repeats', () => {
    const programs = [
      makeProgram(0, { artist: 'Solo' }),
      makeProgram(1, { artist: 'Solo' }),
    ];
    const placements = simulate(makeIterator(programs), HOUR);
    expect(placements).toHaveLength(15);
    expect(new Set(placements.map((p) => p.id))).toEqual(
      new Set(['p0000', 'p0001']),
    );
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i]!.id).not.toBe(placements[i - 1]!.id);
    }
  });

  test('current() is idempotent until next()', () => {
    const programs = makePool(50, 10);
    const state = new RotationState();
    const iterator = new WeightedRotationProgramIterator(
      programs,
      state,
      new Random(MersenneTwister19937.seed(1)),
      resolveRotationParams(),
    );
    const first = iterator.current({ slotDuration: HOUR, timeCursor: START });
    for (let i = 1; i <= 5; i++) {
      expect(
        iterator.current({ slotDuration: HOUR, timeCursor: START + i * HOUR }),
      ).toEqual(first);
    }
    expect(state.songLastAired.size).toBe(0);

    iterator.next();
    expect(state.songLastAired.get(first!.id)).toBe(START + 5 * HOUR);
    const second = iterator.current({
      slotDuration: HOUR,
      timeCursor: START + 6 * HOUR,
    });
    expect(second?.id).not.toBe(first?.id);
  });

  test('an empty pool returns null', () => {
    const iterator = makeIterator([]);
    expect(iterator.current({ slotDuration: HOUR, timeCursor: START })).toBe(
      null,
    );
    iterator.next();
    expect(
      iterator.current({ slotDuration: HOUR, timeCursor: START + HOUR }),
    ).toBe(null);
  });

  test('a stale pick is redone when another iterator airs the same artist', () => {
    const state = new RotationState();
    const params = resolveRotationParams({ tierWeights: { heavy: 1e9 } });
    const x = new WeightedRotationProgramIterator(
      [
        makeProgram(0, { artist: 'A', tier: 'heavy' }),
        makeProgram(1, { artist: 'B' }),
      ],
      state,
      new Random(MersenneTwister19937.seed(1)),
      params,
    );
    const y = new WeightedRotationProgramIterator(
      [makeProgram(2, { artist: 'A' })],
      state,
      new Random(MersenneTwister19937.seed(2)),
      params,
    );
    expect(x.current({ slotDuration: HOUR, timeCursor: START })?.id).toBe(
      'p0000',
    );
    expect(y.current({ slotDuration: HOUR, timeCursor: START })?.id).toBe(
      'p0002',
    );
    y.next();
    expect(
      x.current({ slotDuration: HOUR, timeCursor: START + 4 * MINUTE })?.id,
    ).toBe('p0001');
  });

  test('a song-gap-only candidate beats song-blocked ones', () => {
    const params = resolveRotationParams({ tierWeights: { heavy: 1e9 } });
    for (let seed = 0; seed < 20; seed++) {
      const state = new RotationState();
      const programs = [
        makeProgram(0, { artist: 'A' }),
        ...Array.from({ length: 20 }, (_, i) =>
          makeProgram(i + 1, { artist: `Other ${i}`, tier: 'heavy' }),
        ),
      ];
      state.record(programs[0]!, START - 30 * DAY);
      for (const p of programs.slice(1)) {
        state.record(p, START - HOUR);
      }
      state.record(makeProgram(99, { artist: 'A' }), START - MINUTE);
      const iterator = new WeightedRotationProgramIterator(
        programs,
        state,
        new Random(MersenneTwister19937.seed(seed)),
        params,
      );
      expect(
        iterator.current({ slotDuration: HOUR, timeCursor: START })?.id,
      ).toBe('p0000');
    }
  });

  test('when no candidate meets the artist gap, the stalest artist airs', () => {
    for (let seed = 0; seed < 20; seed++) {
      const state = new RotationState();
      const programs = [
        makeProgram(0, { artist: 'R.E.M.' }),
        makeProgram(1, { artist: 'R.E.M.' }),
        makeProgram(2, { artist: 'R.E.M.' }),
        makeProgram(3, { artist: 'Weezer' }),
        makeProgram(4, { artist: 'Blur' }),
      ];
      state.record(makeProgram(90, { artist: 'R.E.M.' }), START - MINUTE);
      state.record(makeProgram(91, { artist: 'Weezer' }), START - 30 * MINUTE);
      state.record(makeProgram(92, { artist: 'Blur' }), START - 50 * MINUTE);
      const iterator = new WeightedRotationProgramIterator(
        programs,
        state,
        new Random(MersenneTwister19937.seed(seed)),
        resolveRotationParams(),
      );
      expect(
        iterator.current({ slotDuration: HOUR, timeCursor: START })?.id,
      ).toBe('p0004');
    }
  });

  test('the song-blocked fallback still prefers an artist-gap-safe candidate', () => {
    const params = resolveRotationParams({ artistGapMs: 10 * MINUTE });
    for (let seed = 0; seed < 20; seed++) {
      const state = new RotationState();
      const programs = [
        makeProgram(0, { artist: 'A' }),
        makeProgram(1, { artist: 'B' }),
      ];
      state.record(programs[0]!, START - 30 * MINUTE);
      state.record(programs[1]!, START - 20 * MINUTE);
      state.record(makeProgram(99, { artist: 'A' }), START - MINUTE);
      const iterator = new WeightedRotationProgramIterator(
        programs,
        state,
        new Random(MersenneTwister19937.seed(seed)),
        params,
      );
      expect(
        iterator.current({ slotDuration: HOUR, timeCursor: START })?.id,
      ).toBe('p0001');
    }
  });

  test('all-zero weights fall back to the least recently aired', () => {
    const params = {
      ...resolveRotationParams({ songGapMs: 0, artistGapMs: 0 }),
      tierWeights: { heavy: 0, medium: 0, light: 0 },
    };
    for (let seed = 0; seed < 20; seed++) {
      const state = new RotationState();
      const programs = [0, 1, 2].map((i) =>
        makeProgram(i, { artist: `Artist ${i}` }),
      );
      state.record(programs[0]!, START - 5 * MINUTE);
      state.record(programs[1]!, START - 10 * MINUTE);
      state.record(programs[2]!, START - MINUTE);
      const iterator = new WeightedRotationProgramIterator(
        programs,
        state,
        new Random(MersenneTwister19937.seed(seed)),
        params,
      );
      expect(
        iterator.current({ slotDuration: HOUR, timeCursor: START })?.id,
      ).toBe('p0001');
    }
  });
});

describe('RotationState', () => {
  test('records the song and every artist key', () => {
    const state = new RotationState();
    state.record(makeProgram(0, { artist: 'The Roots & Erykah Badu' }), 123);
    expect(state.songLastAired.get('p0000')).toBe(123);
    expect(state.artistLastAired.get('roots')).toBe(123);
    expect(state.artistLastAired.get('erykah badu')).toBe(123);
  });

  test('every record bumps the version', () => {
    const state = new RotationState();
    expect(state.version).toBe(0);
    state.record(makeProgram(0, { artist: 'A' }), 1);
    state.record(makeProgram(0, { artist: 'A' }), 2);
    expect(state.version).toBe(2);
  });
});

describe('resolveRotationParams', () => {
  test('fills defaults and merges partial tiers', () => {
    const resolved = resolveRotationParams({
      tierWeights: { heavy: 5 },
      artistGapMs: 0,
    });
    expect(resolved.tierWeights).toEqual({ heavy: 5, medium: 2, light: 1 });
    expect(resolved.targetIntervalMs).toEqual({
      heavy: 2 * DAY,
      medium: 5 * DAY,
      light: 10 * DAY,
    });
    expect(resolved.songGapMs).toBe(DAY);
    expect(resolved.artistGapMs).toBe(0);
  });

  test('no input gives the defaults', () => {
    expect(resolveRotationParams()).toEqual({
      tierWeights: { heavy: 3, medium: 2, light: 1 },
      targetIntervalMs: { heavy: 2 * DAY, medium: 5 * DAY, light: 10 * DAY },
      songGapMs: DAY,
      artistGapMs: HOUR,
    });
  });
});
