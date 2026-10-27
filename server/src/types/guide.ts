import type { ProgramWithRelationsOrm } from '../db/schema/derivedTypes.ts';

export type ProgramGuideItem = {
  type: 'program';
  program: ProgramWithRelationsOrm;
};

export type FlexGuideItem = {
  type: 'flex';
};

export type RedirectGuideItem = {
  type: 'redirect';
  channelId: string;
  channelNumber: number;
  channelName: string;
};

export type MaterializedGuideItem = {
  start: number;
  stop: number;
  isPaused?: boolean;
  timeRemaining?: number;
  durationMs: number;
  title?: string;
  description?: string;
  programming: ProgramGuideItem | FlexGuideItem | RedirectGuideItem;
};
