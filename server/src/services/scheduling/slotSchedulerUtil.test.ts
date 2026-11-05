import type { CondensedChannelProgram } from '@tunarr/types';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { describe, expect, test } from 'vitest';
import { pushOrExtendFlex } from './slotSchedulerUtil.ts';

dayjs.extend(duration);

describe('pushOrExtendFlex', () => {
  test('extends a trailing plain flex', () => {
    const lineup: CondensedChannelProgram[] = [
      { type: 'flex', duration: 1000 },
    ];

    pushOrExtendFlex(lineup, dayjs.duration(500));

    expect(lineup).toEqual([{ type: 'flex', duration: 1500 }]);
  });

  test('never merges into a mid-roll break', () => {
    const lineup: CondensedChannelProgram[] = [
      {
        type: 'flex',
        duration: 1000,
        fillerConfig: { origin: 'midroll', fillerListIds: ['mid'] },
      },
    ];

    pushOrExtendFlex(lineup, dayjs.duration(500));

    expect(lineup).toEqual([
      {
        type: 'flex',
        duration: 1000,
        fillerConfig: { origin: 'midroll', fillerListIds: ['mid'] },
      },
      { type: 'flex', duration: 500 },
    ]);
  });
});
