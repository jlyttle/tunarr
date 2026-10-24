import {
  slotIsLinkable,
  type BaseSlot,
  type LinkableBaseSlot,
} from '@tunarr/types/api';
import { map, pick, uniqBy } from 'lodash-es';
import { slotIteratorKey } from './ProgramIterator.js';

type ValidationResult<T> = {
  valid: boolean;
  errors: string[];
  sanitizedSlots: T[];
};

type ValidationOptions = {
  scheduleType?: 'time' | 'random';
};

type CursorSlot = Extract<LinkableBaseSlot, { type: 'show' | 'custom-show' }>;

function hasEpisodeCursor(slot: LinkableBaseSlot): slot is CursorSlot {
  if (slot.type !== 'show' && slot.type !== 'custom-show') return false;
  return (
    !!slot.startProgramId ||
    !!slot.excludeProgramIds?.length ||
    !!slot.playFirstProgramIds?.length
  );
}

function episodeCursorKey(slot: CursorSlot): string {
  return JSON.stringify([
    slot.startProgramId ?? null,
    [...(slot.excludeProgramIds ?? [])].sort(),
    [...(slot.playFirstProgramIds ?? [])].sort(),
  ]);
}

function withEpisodeCursor<T extends BaseSlot>(slot: T, source: CursorSlot): T {
  if (slot.type !== 'show' && slot.type !== 'custom-show') return slot;
  return {
    ...slot,
    ...pick(source, [
      'startProgramId',
      'excludeProgramIds',
      'playFirstProgramIds',
    ]),
  };
}

function shareGroupCursor<T extends BaseSlot>(
  groupSlots: LinkableBaseSlot[],
  source: CursorSlot,
  sanitizedSlots: T[],
) {
  for (const slot of groupSlots) {
    if (hasEpisodeCursor(slot)) continue;
    const idx = sanitizedSlots.indexOf(slot as T);
    if (idx !== -1) {
      sanitizedSlots[idx] = withEpisodeCursor(sanitizedSlots[idx]!, source);
    }
  }
}

export function validateSlotGroups<T extends BaseSlot>(
  slots: T[],
  options: ValidationOptions = {},
): ValidationResult<T> {
  const errors: string[] = [];

  const sanitizedSlots = slots.map((slot): T => {
    if (!slotIsLinkable(slot)) return slot;
    if (slot.linkMode && !slot.iterationGroup) {
      const { linkMode: _, ...rest } = slot;
      return rest as T;
    }
    return slot;
  });

  const groups = new Map<string, LinkableBaseSlot[]>();

  for (const slot of sanitizedSlots) {
    if (!slotIsLinkable(slot)) continue;
    if (!slot.iterationGroup) continue;

    let group = groups.get(slot.iterationGroup);
    if (!group) {
      group = [];
      groups.set(slot.iterationGroup, group);
    }

    group.push(slot);
  }

  for (const [groupId, slots] of groups) {
    if (slots.length < 2) {
      for (const slot of slots) {
        const idx = sanitizedSlots.indexOf(slot as T);
        if (idx !== -1) {
          const {
            iterationGroup: _,
            linkMode: __,
            ...rest
          } = sanitizedSlots[idx] as LinkableBaseSlot;
          sanitizedSlots[idx] = rest as T;
        }
      }
      continue;
    }

    const slotOrders = uniqBy(slots, (slot) => slot.order);
    if (slotOrders.length > 1) {
      errors.push(
        `Group ${groupId} has mismatched orderings: ${slotOrders.map((slot) => slot.order).join(', ')}`,
      );
    }
    const slotDirections = uniqBy(slots, (slot) => slot.direction);
    if (slotDirections.length > 1) {
      errors.push(
        `Group ${groupId} has mismatched direction values: ${slotDirections.map((slot) => slot.direction).join(', ')}`,
      );
    }
    const slotContentKeys = new Set(
      map(slots, (slot) => slotIteratorKey(slot)),
    );
    if (slotContentKeys.size > 1) {
      errors.push(
        `Group ${groupId} has mismatched content keys: ${[...slotContentKeys].join(', ')}`,
      );
    }
    const cursorSlots = slots.filter(hasEpisodeCursor);
    const slotCursorKeys = new Set(map(cursorSlots, episodeCursorKey));
    if (slotCursorKeys.size > 1) {
      errors.push(
        `Group ${groupId} has mismatched episode cursor fields on slots: ${map(cursorSlots, 'id').join(', ')}`,
      );
    } else if (cursorSlots.length > 0) {
      shareGroupCursor(slots, cursorSlots[0]!, sanitizedSlots);
    }
    const slotLinkModes = new Set(
      map(slots, (slot) => slot.linkMode ?? 'continue'),
    );
    if (slotLinkModes.size > 1) {
      if (options.scheduleType === 'random') {
        errors.push(
          `Group ${groupId} has mismatched linkMode values. ` +
            `Random slot schedules require all slots in a group to use the same link mode.`,
        );
      } else if (!slotLinkModes.has('continue')) {
        errors.push(
          `Group ${groupId} has rerun slots but no continue slot to produce content.`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedSlots,
  };
}
