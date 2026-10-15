import { beforeEach, expect, it, jest } from '@jest/globals';

import {
  logCompletedPracticeHabit,
  type PracticeHabitLogInput,
  type TimerHabitLogService,
} from '../practiceHabitLogging';

import type { CheckInResult, PracticeSessionCreate, PracticeSessionResponse } from '@/api';
import type { LogUnitContext } from '@/features/Habits/services/habitManager';

const payload: PracticeSessionCreate = {
  user_practice_id: 7,
  started_at: '2026-10-14T12:00:00Z',
  ended_at: '2026-10-14T12:20:00Z',
  completed: true,
};
const session: PracticeSessionResponse = {
  id: 50,
  user_practice_id: 7,
  duration_minutes: 20,
  timestamp: payload.ended_at,
  mode: 'meditation_timer',
  mode_metadata: null,
  reflection: null,
  insight: null,
  completed: true,
};
const confirmed: CheckInResult = {
  streak: 2,
  milestones: [],
  reason_code: 'completed',
  day_units: 20,
};
const ctx = {
  operationId: 'original-operation',
  amount: 20,
  habitId: 5,
  serverGoalId: 25,
  isDemoSeed: false,
} as LogUnitContext;
function input(): PracticeHabitLogInput {
  return {
    session,
    payload,
    habit: { id: 5, name: 'Metta', unit: 'minutes' },
    timezone: 'UTC',
    isCurrent: () => true,
    isOwnerCurrent: () => true,
    onNotice: jest.fn(),
    manager: {
      prepareLogUnit: jest.fn(() => ctx),
      reserveLogUnitContext: jest.fn(),
      discardLogUnitContext: jest.fn(),
      reconcileReservedLogUnitContext: jest.fn(),
      commitLogUnitContext: jest.fn<TimerHabitLogService['commitLogUnitContext']>(
        async (_ctx, options) => {
          options.onCommitted(confirmed);
          return confirmed;
        },
      ),
    },
  };
}
beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
it('logs measured minutes with the original operation identity and reconciles inside the commit callback', async () => {
  const p = input();
  await expect(logCompletedPracticeHabit(p)).resolves.toBe('logged');
  expect(p.manager.prepareLogUnit).toHaveBeenCalledWith(5, 20, 'UTC', new Date(payload.ended_at));
  expect(p.manager.reserveLogUnitContext).toHaveBeenCalledWith(ctx);
  expect(p.manager.commitLogUnitContext).toHaveBeenCalledWith(
    ctx,
    expect.objectContaining({ viaTimer: true, isCurrent: p.isCurrent }),
  );
  expect(p.manager.reconcileReservedLogUnitContext).toHaveBeenCalledWith(ctx, confirmed);
  expect(p.manager.discardLogUnitContext).toHaveBeenCalledWith(ctx);
  expect(p.onNotice).toHaveBeenCalledWith('Logged 20 minutes to Metta');
  expect(ctx.operationId).toBe('original-operation');
});
it('adds one session for each separately completed sitting, regardless of minutes', async () => {
  const p = input();
  p.habit.unit = 'sessions';
  await logCompletedPracticeHabit(p);
  await logCompletedPracticeHabit({ ...p, session: { ...session, id: 51 } });
  expect(p.manager.prepareLogUnit).toHaveBeenNthCalledWith(
    1,
    5,
    1,
    'UTC',
    new Date(payload.ended_at),
  );
  expect(p.manager.prepareLogUnit).toHaveBeenNthCalledWith(
    2,
    5,
    1,
    'UTC',
    new Date(payload.ended_at),
  );
  expect(p.onNotice).toHaveBeenLastCalledWith('Logged a session to Metta');
});
it('never claims a log after a failed habit request and always discards its reservation', async () => {
  const p = input();
  p.manager.commitLogUnitContext = jest.fn(async () => {
    throw new Error('offline');
  });
  await expect(logCompletedPracticeHabit(p)).resolves.toBe('failed');
  expect(p.manager.reconcileReservedLogUnitContext).not.toHaveBeenCalled();
  expect(p.manager.discardLogUnitContext).toHaveBeenCalledWith(ctx);
  expect(p.onNotice).toHaveBeenCalledWith("Couldn't log to Metta");
  expect(console.warn).toHaveBeenCalledTimes(1);
});
it('does not reserve a log for an unconfirmed, stale or invalid session', async () => {
  for (const changes of [
    { isCurrent: () => false },
    { session: { ...session, completed: false } },
    { payload: { ...payload, ended_at: payload.started_at } },
    { session: { ...session, user_practice_id: 8 } },
  ]) {
    const p = { ...input(), ...changes };
    await expect(logCompletedPracticeHabit(p)).resolves.toBe('ignored');
    expect(p.manager.reserveLogUnitContext).not.toHaveBeenCalled();
    expect(p.manager.commitLogUnitContext).not.toHaveBeenCalled();
  }
});
it('never reconciles or shows a notice to an incoming owner after the request', async () => {
  const p = input();
  let owner = true;
  p.isCurrent = () => owner;
  p.isOwnerCurrent = () => owner;
  p.manager.commitLogUnitContext = jest.fn<TimerHabitLogService['commitLogUnitContext']>(
    async (_ctx, options) => {
      owner = false;
      options.onCommitted(confirmed);
      return confirmed;
    },
  );
  await logCompletedPracticeHabit(p);
  expect(p.manager.reconcileReservedLogUnitContext).not.toHaveBeenCalled();
  expect(p.onNotice).not.toHaveBeenCalled();
  expect(p.manager.discardLogUnitContext).toHaveBeenCalledWith(ctx);
});
it('reconciles confirmed old-link work for the same owner without an obsolete notice', async () => {
  const p = input();
  let linked = true;
  p.isCurrent = () => linked;
  p.manager.commitLogUnitContext = jest.fn<TimerHabitLogService['commitLogUnitContext']>(
    async (_ctx, options) => {
      linked = false;
      options.onCommitted(confirmed);
      return confirmed;
    },
  );
  await logCompletedPracticeHabit(p);
  expect(p.manager.reconcileReservedLogUnitContext).toHaveBeenCalledWith(ctx, confirmed);
  expect(p.onNotice).not.toHaveBeenCalled();
});
it('a cancelled queued reservation never creates a success notice', async () => {
  const p = input();
  p.manager.commitLogUnitContext = jest.fn(async () => null);
  await expect(logCompletedPracticeHabit(p)).resolves.toBe('ignored');
  expect(p.manager.reconcileReservedLogUnitContext).not.toHaveBeenCalled();
  expect(p.onNotice).not.toHaveBeenCalled();
  expect(p.manager.discardLogUnitContext).toHaveBeenCalledWith(ctx);
});
it('hands a failed attempt its context and resends that same context on retry', async () => {
  const p = input();
  const onFailed = jest.fn();
  p.manager.commitLogUnitContext = jest.fn(async () => {
    throw new Error('offline');
  });
  await logCompletedPracticeHabit({ ...p, onFailed });
  expect(onFailed).toHaveBeenCalledWith(ctx);
  const retry = input();
  await expect(logCompletedPracticeHabit({ ...retry, prepared: ctx })).resolves.toBe('logged');
  expect(retry.manager.prepareLogUnit).not.toHaveBeenCalled();
  expect(retry.manager.commitLogUnitContext).toHaveBeenCalledWith(ctx, expect.anything());
});
it('never resends a prepared context to a different habit', async () => {
  const p = input();
  p.habit.id = 6;
  await expect(logCompletedPracticeHabit({ ...p, prepared: ctx })).resolves.toBe('ignored');
  expect(p.manager.reserveLogUnitContext).not.toHaveBeenCalled();
  expect(p.manager.commitLogUnitContext).not.toHaveBeenCalled();
});
