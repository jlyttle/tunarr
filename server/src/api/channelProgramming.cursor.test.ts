import { LineupSchema } from '@/db/derived_types/Lineup.js';
import { MaterializedSchedule } from '@tunarr/types/api';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/util/logging/LoggerFactory.js', () => {
  const stubLogger: Record<string, unknown> = {};
  for (const level of ['error', 'warn', 'info', 'debug', 'trace', 'fatal']) {
    stubLogger[level] = () => {};
  }
  stubLogger.child = () => stubLogger;
  return {
    LoggerFactory: {
      child: () => stubLogger,
      root: stubLogger,
      get: () => stubLogger,
    },
    Logger: stubLogger,
  };
});

const state = vi.hoisted(() => ({
  execute: undefined as undefined | ((req: unknown) => Promise<unknown>),
}));

vi.mock('../container.ts', () => ({
  container: {
    get: () => ({ execute: (req: unknown) => state.execute!(req) }),
  },
}));

vi.mock('@/services/Scheduler.js', () => ({
  GlobalScheduler: {
    getScheduledJob: () => ({ runNow: () => Promise.resolve() }),
  },
}));

import { GetMaterializedChannelScheduleCommand } from '../commands/GetMaterializedChannelScheduleCommand.ts';
import { channelsApi } from './channelsApi.js';

const channelId = '33333333-3333-4333-8333-333333333333';
const showId = '44444444-4444-4444-8444-444444444444';
const startProgramId = '55555555-5555-4555-8555-555555555555';
const excludeProgramIds = [
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
];
const playFirstProgramIds = ['88888888-8888-4888-8888-888888888888'];

const showSlot = {
  type: 'show',
  id: '99999999-9999-4999-8999-999999999999',
  showId,
  order: 'next',
  direction: 'asc',
  seasonFilter: [],
  startTime: 0,
  startProgramId,
  excludeProgramIds,
  playFirstProgramIds,
};

describe('episode cursor fields survive save and schedule read-back', () => {
  let app: ReturnType<typeof Fastify>;
  let storedLineup: unknown;

  beforeEach(async () => {
    storedLineup = undefined;
    const channelDB = {
      getChannel: async () => ({ uuid: channelId }),
      updateLineup: async (_id: string, request: { schedule: unknown }) => {
        storedLineup = LineupSchema.parse({
          version: 6,
          lastUpdated: 0,
          items: [],
          startTimeOffsets: [],
          schedule: request.schedule,
        });
        return { materializedPrograms: [] };
      },
      condensedLineupFromMaterialized: async () => ({}),
      loadLineup: async () => storedLineup,
    };
    const readBackCommand = new GetMaterializedChannelScheduleCommand(
      {
        channelDB,
        programDB: { getProgramGroupings: async () => ({}) },
        fillerDB: { getFillerListsByIds: async () => [] },
        customShowDB: { getShows: async () => [] },
        smartCollectionsDB: { getByIds: async () => [] },
      } as never,
      { execute: async () => [] } as never,
    );
    state.execute = (req) => readBackCommand.execute(req as never);

    app = Fastify()
      .setValidatorCompiler(validatorCompiler)
      .setSerializerCompiler(serializerCompiler)
      .withTypeProvider<ZodTypeProvider>();
    app.decorateRequest('serverCtx', null);
    app.addHook('onRequest', (req, _res, done) => {
      (req as unknown as { serverCtx: unknown }).serverCtx = { channelDB };
      done();
    });
    await app.register(channelsApi);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function saveAndReadBack(body: object) {
    const saved = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/programming`,
      payload: body,
    });
    expect([saved.statusCode, saved.body]).toEqual([200, saved.body]);
    const read = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/schedule`,
    });
    expect([read.statusCode, read.body]).toEqual([200, read.body]);
    return read.json().schedule;
  }

  it.each(['time', 'random'] as const)(
    'cursor fields survive a %s schedule save and read-back',
    async (type) => {
      const schedule =
        type === 'time'
          ? {
              type: 'time',
              flexPreference: 'distribute',
              latenessMs: 0,
              maxDays: 1,
              padMs: 1,
              period: 'day',
              slots: [showSlot],
              timeZoneOffset: 0,
              loop: true,
            }
          : {
              type: 'random',
              padMs: 1,
              padStyle: 'slot',
              randomDistribution: 'uniform',
              flexPreference: 'distribute',
              slots: [{ ...showSlot, weight: 1, cooldownMs: 0 }],
              maxDays: 1,
            };

      const readBack = await saveAndReadBack({
        type,
        programs: [],
        schedule,
      });

      expect(readBack.slots[0]).toMatchObject({
        startProgramId,
        excludeProgramIds,
        playFirstProgramIds,
      });
      expect(MaterializedSchedule.parse(readBack).slots[0]).toMatchObject({
        startProgramId,
        excludeProgramIds,
        playFirstProgramIds,
      });
    },
  );
});
