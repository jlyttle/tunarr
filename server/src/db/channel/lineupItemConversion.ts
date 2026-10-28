import type { CondensedChannelProgram } from '@tunarr/types';
import { isNonEmptyString } from '@tunarr/shared/util';
import { match } from 'ts-pattern';
import type { LineupItem } from '../derived_types/Lineup.ts';

export function condensedProgramToLineupItem(
  p: CondensedChannelProgram,
): LineupItem {
  return { ...toLineupItem(p), ...guideFields(p) };
}

export function guideFields(p: {
  guideTitle?: string;
  guideDescription?: string;
}) {
  if (!isNonEmptyString(p.guideTitle)) {
    return {};
  }
  return { guideTitle: p.guideTitle, guideDescription: p.guideDescription };
}

function toLineupItem(p: CondensedChannelProgram): LineupItem {
  return match(p)
    .returnType<LineupItem>()
    .with({ type: 'content' }, (program) => ({
      type: 'content',
      id: program.id,
      durationMs: program.duration,
      startOffsetMs: program.startOffsetMs,
    }))
    .with({ type: 'custom' }, (program) => ({
      type: 'content',
      durationMs: program.duration,
      id: program.id,
      customShowId: program.customShowId,
      startOffsetMs: program.startOffsetMs,
    }))
    .with({ type: 'filler' }, (program) => ({
      type: 'content',
      durationMs: program.duration,
      id: program.id,
      fillerListId: program.fillerListId,
      fillerType: program.fillerType,
    }))
    .with({ type: 'redirect' }, (program) => ({
      type: 'redirect',
      channel: program.channel,
      durationMs: program.duration,
    }))
    .with({ type: 'flex' }, (program) => ({
      type: 'offline',
      durationMs: program.duration,
      fillerConfig: program.fillerConfig,
    }))
    .exhaustive();
}
