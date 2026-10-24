import { StrictTimeSlotScheduleSchema } from '@tunarr/types/api';
import { describe, expect, test } from 'vitest';
import { validateSlotGroups } from './slotGroupValidator.ts';

describe('validateSlotGroups', () => {
  const validGroupId = '550e8400-e29b-41d4-a716-446655440000';

  test('accepts slots with no groups', () => {
    const result = validateSlotGroups([
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '1',
      },
      {
        type: 'show',
        showId: 'show2',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '2',
      },
    ]);
    expect(result.valid).toBe(true);
  });

  test('accepts valid group with matching content', () => {
    const result = validateSlotGroups([
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '1',
        iterationGroup: validGroupId,
        linkMode: 'continue',
      },
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '2',
        iterationGroup: validGroupId,
        linkMode: 'continue',
      },
    ]);
    expect(result.valid).toBe(true);
  });

  test('rejects group with mismatched content keys', () => {
    const result = validateSlotGroups([
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '1',
        iterationGroup: validGroupId,
        linkMode: 'continue',
      },
      {
        type: 'show',
        showId: 'show2',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '2',
        iterationGroup: validGroupId,
        linkMode: 'continue',
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('content');
  });

  test('accepts mixed linkMode group for time slots with at least one continue slot', () => {
    const result = validateSlotGroups(
      [
        {
          type: 'show',
          showId: 'show1',
          order: 'next',
          direction: 'asc',
          seasonFilter: [],
          id: '1',
          iterationGroup: validGroupId,
          linkMode: 'continue',
        },
        {
          type: 'show',
          showId: 'show1',
          order: 'next',
          direction: 'asc',
          seasonFilter: [],
          id: '2',
          iterationGroup: validGroupId,
          linkMode: 'rerun',
        },
      ],
      { scheduleType: 'time' },
    );
    expect(result.valid).toBe(true);
  });

  test('accepts all-rerun group (legacy behavior)', () => {
    const result = validateSlotGroups([
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '1',
        iterationGroup: validGroupId,
        linkMode: 'rerun',
      },
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '2',
        iterationGroup: validGroupId,
        linkMode: 'rerun',
      },
    ]);
    expect(result.valid).toBe(true);
  });

  test('rejects mixed linkMode group for random slots', () => {
    const result = validateSlotGroups(
      [
        {
          type: 'show',
          showId: 'show1',
          order: 'next',
          direction: 'asc',
          seasonFilter: [],
          id: '1',
          iterationGroup: validGroupId,
          linkMode: 'continue',
        },
        {
          type: 'show',
          showId: 'show1',
          order: 'next',
          direction: 'asc',
          seasonFilter: [],
          id: '2',
          iterationGroup: validGroupId,
          linkMode: 'rerun',
        },
      ],
      { scheduleType: 'random' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Random slot');
  });

  test('rejects mixed linkMode group with no continue slot', () => {
    const result = validateSlotGroups(
      [
        {
          type: 'show',
          showId: 'show1',
          order: 'next',
          direction: 'asc',
          seasonFilter: [],
          id: '1',
          iterationGroup: validGroupId,
          linkMode: 'rerun',
        },
        {
          type: 'movie',
          order: 'next',
          direction: 'asc',
          id: '2',
          iterationGroup: validGroupId,
          linkMode: 'rerun',
        },
      ],
      { scheduleType: 'time' },
    );
    // Size is 1 (both rerun), so mixed check doesn't trigger.
    // But content keys mismatch (show vs movie).
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('content');
  });

  test('strips linkMode when iterationGroup is absent', () => {
    const slots = [
      {
        type: 'show' as const,
        showId: 'show1',
        order: 'next' as const,
        direction: 'asc' as const,
        seasonFilter: [],
        id: '1',
        linkMode: 'rerun' as const,
      },
    ];
    const result = validateSlotGroups(slots);
    expect(result.valid).toBe(true);
    expect(result.sanitizedSlots[0]).not.toHaveProperty('linkMode');
  });

  test('accepts solo group member', () => {
    const result = validateSlotGroups([
      {
        type: 'show',
        showId: 'show1',
        order: 'next',
        direction: 'asc',
        seasonFilter: [],
        id: '1',
        iterationGroup: validGroupId,
        linkMode: 'continue',
      },
    ]);
    expect(result.valid).toBe(true);
  });

  describe('episode cursor fields', () => {
    const programA = '11111111-1111-4111-8111-111111111111';
    const programB = '22222222-2222-4222-8222-222222222222';
    const programC = '33333333-3333-4333-8333-333333333333';

    const cursorShowSlot = (
      id: string,
      cursor: {
        startProgramId?: string;
        excludeProgramIds?: string[];
        playFirstProgramIds?: string[];
      },
    ) => ({
      type: 'show' as const,
      showId: 'show1',
      order: 'next' as const,
      direction: 'asc' as const,
      seasonFilter: [],
      id,
      iterationGroup: validGroupId,
      linkMode: 'continue' as const,
      ...cursor,
    });

    test('keeps cursor fields on show slots', () => {
      const slot = {
        type: 'show' as const,
        showId: 'show1',
        order: 'next' as const,
        direction: 'asc' as const,
        seasonFilter: [],
        id: '1',
        startProgramId: programA,
        excludeProgramIds: [programB],
        playFirstProgramIds: [programC],
      };
      const result = validateSlotGroups([slot]);
      expect(result.valid).toBe(true);
      expect(result.sanitizedSlots[0]).toMatchObject({
        startProgramId: programA,
        excludeProgramIds: [programB],
        playFirstProgramIds: [programC],
      });
    });

    test('reports mismatched cursor fields in a group', () => {
      const result = validateSlotGroups([
        cursorShowSlot('1', { startProgramId: programA }),
        cursorShowSlot('2', { startProgramId: programB }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain(
        'mismatched episode cursor fields on slots: 1, 2',
      );
    });

    test('slot without cursor fields inherits the group cursor', () => {
      const cursor = {
        startProgramId: programA,
        excludeProgramIds: [programB],
        playFirstProgramIds: [programC],
      };
      const result = validateSlotGroups([
        cursorShowSlot('1', cursor),
        cursorShowSlot('2', {}),
        cursorShowSlot('3', cursor),
      ]);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.sanitizedSlots[1]).toMatchObject({ id: '2', ...cursor });
    });

    test('different cursors stay an error when another slot has none', () => {
      const result = validateSlotGroups([
        cursorShowSlot('1', { startProgramId: programA }),
        cursorShowSlot('2', {}),
        cursorShowSlot('3', { excludeProgramIds: [programB] }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain(
        'mismatched episode cursor fields on slots: 1, 3',
      );
    });

    test('group without cursor fields stays unchanged', () => {
      const slots = [cursorShowSlot('1', {}), cursorShowSlot('2', {})];
      const result = validateSlotGroups(slots);
      expect(result.valid).toBe(true);
      expect(result.sanitizedSlots).toEqual(slots);
    });

    test('accepts identical cursor fields in a group', () => {
      const result = validateSlotGroups([
        cursorShowSlot('1', {
          startProgramId: programA,
          excludeProgramIds: [programB, programC],
        }),
        cursorShowSlot('2', {
          startProgramId: programA,
          excludeProgramIds: [programC, programB],
        }),
      ]);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('strict schedule schema does not strip cursor fields', () => {
      const parsed = StrictTimeSlotScheduleSchema.parse({
        type: 'time',
        flexPreference: 'distribute',
        latenessMs: 0,
        maxDays: 1,
        padMs: 1,
        period: 'day',
        timeZoneOffset: 0,
        slots: [
          {
            type: 'show',
            showId: 'show1',
            order: 'next',
            direction: 'asc',
            id: validGroupId,
            startTime: 0,
            startProgramId: programA,
            excludeProgramIds: [programB],
            playFirstProgramIds: [programC],
          },
        ],
      });
      expect(parsed.slots[0]).toMatchObject({
        startProgramId: programA,
        excludeProgramIds: [programB],
        playFirstProgramIds: [programC],
      });
    });
  });
});
