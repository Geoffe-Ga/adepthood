import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { goalCompletions, goalGroups, goals, habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import {
  clearCheckInReplayState,
  loadCheckInReplayState,
  saveCheckInReplayState,
} from '@/storage/checkInReplayState';
import {
  capturePendingCheckInScope,
  removePendingCheckIns,
  recordDroppedCheckIn,
  loadDroppedCheckIns,
  loadHabits,
  loadPendingCheckIns,
  saveHabits,
  savePendingCheckIn,
} from '@/storage/habitStorage';
import { serialize } from '@/storage/serializedWrite';
import { setActiveUser, scopedKey } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { listAll: jest.fn(), create: jest.fn() },
  goalGroups: { list: jest.fn() },
  goals: { update: jest.fn() },
  goalCompletions: { create: jest.fn() },
}));
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tokenFor = (owner: number) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
function habit(id: number, name: string): Habit {
  return {
    id,
    name,
    icon: '🧘',
    stage: 'Beige',
    streak: 0,
    revealed: true,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date('2026-01-01T00:00:00Z'),
    completions: [],
    goals: (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
      id: id * 10 + index + 1,
      title: tier,
      tier,
      target: 1,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    })),
  };
}
const outgoing = habit(42, 'Outgoing sitting');
const incoming = habit(202, 'Incoming walk');
const returning = habit(303, 'Returning account fresh row');
const serverRows = (row = outgoing) =>
  [{ ...row, start_date: '2026-01-01' }] as Awaited<ReturnType<typeof habits.listAll>>;
async function adopt(owner: number, row: Habit) {
  setActiveUser(owner);
  setTokenGetter(() => tokenFor(owner));
  useHabitStore.getState().setHabits([row]);
  await saveHabits([row]);
}
async function snapshot() {
  return {
    memory: useHabitStore.getState().habits.map((row) => row.id),
    disk: (await loadHabits())?.map((row) => row.id),
  };
}
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.mocked(habits.listAll).mockReset();
  jest.mocked(habits.create).mockReset();
  jest.mocked(goalGroups.list).mockReset().mockResolvedValue([]);
  jest.mocked(goals.update).mockReset();
  jest.mocked(goalCompletions.create).mockReset();
  await adopt(1, outgoing);
});
afterEach(() => {
  jest.restoreAllMocks();
  setActiveUser(null);
  setTokenGetter(null);
});

it.each(['other account', 'same account new lifecycle'])(
  'ignores an old server refresh after %s takes over',
  async (kind) => {
    const response = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
    const entered = deferred<void>();
    jest.mocked(habits.listAll).mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const refreshing = habitManager.refreshHabits('UTC');
    await entered.promise;
    await adopt(2, incoming);
    if (kind === 'same account new lifecycle') await adopt(1, returning);
    response.resolve(serverRows());
    expect(await refreshing).toBe(false);
    const expected = kind === 'other account' ? 202 : 303;
    expect(await snapshot()).toEqual({ memory: [expected], disk: [expected] });
  },
);

it('keeps the incoming account when an outgoing scoped-cache read finishes late', async () => {
  const key = scopedKey('@adepthood/habits');
  const originalRead = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
  const cached = await originalRead(key);
  const response = deferred<string | null>();
  const entered = deferred<void>();
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation((reading) => {
    if (reading !== key) return originalRead(reading);
    entered.resolve();
    return response.promise;
  });
  jest.mocked(habits.listAll).mockRejectedValueOnce(new Error('offline after switch'));
  const refreshing = habitManager.refreshHabits('UTC');
  await entered.promise;
  await adopt(2, incoming);
  response.resolve(cached);
  await refreshing;
  jest.mocked(AsyncStorage.getItem).mockImplementation(originalRead);
  expect(habits.listAll).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('refuses a refresh when the namespace belongs to a different token', async () => {
  await adopt(2, incoming);
  setTokenGetter(() => tokenFor(1));
  jest.mocked(habits.listAll).mockResolvedValueOnce(serverRows());
  await habitManager.refreshHabits('UTC');
  expect(habits.listAll).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('preserves a same-account successful server refresh', async () => {
  const fresh = habit(404, 'Confirmed current account row');
  jest.mocked(habits.listAll).mockResolvedValueOnce(serverRows(fresh));
  expect(await habitManager.refreshHabits('UTC')).toBe(true);
  expect(habits.listAll).toHaveBeenCalledWith(tokenFor(1));
  expect(await snapshot()).toEqual({ memory: [404], disk: [404] });
});

it('stops recovery after the initiating account leaves and pins the first POST credential', async () => {
  await saveHabits([outgoing, habit(43, 'Second outgoing row')]);
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<typeof habits.create>>>();
  jest.mocked(habits.listAll).mockResolvedValueOnce([]);
  jest.mocked(habits.create).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const refreshing = habitManager.refreshHabits('UTC');
  await entered.promise;
  await adopt(2, incoming);
  response.resolve(serverRows()[0]!);
  expect(await refreshing).toBe(false);
  expect(habits.create).toHaveBeenCalledWith(
    expect.objectContaining({ name: outgoing.name }),
    tokenFor(1),
  );
  expect(habits.create).toHaveBeenCalledTimes(1);
  expect(habits.listAll).toHaveBeenCalledTimes(1);
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it.each(['group read', 'goal write'])(
  'stops cached goal replay after an old %s finishes',
  async (held) => {
    const fresh = { ...outgoing, goals: outgoing.goals.map((goal) => ({ ...goal, target: 3 })) };
    jest.mocked(habits.listAll).mockResolvedValueOnce([]).mockResolvedValueOnce(serverRows(fresh));
    jest.mocked(habits.create).mockResolvedValue(serverRows()[0]!);
    const entered = deferred<void>();
    const release = deferred<void>();
    if (held === 'group read') {
      jest.mocked(goalGroups.list).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return [];
      });
    } else {
      jest.mocked(goals.update).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return serverRows()[0]!.goals[0]!;
      });
    }
    const refreshing = habitManager.refreshHabits('UTC');
    await entered.promise;
    await adopt(2, incoming);
    release.resolve();
    expect(await refreshing).toBe(false);
    expect(goalGroups.list).toHaveBeenCalledWith(tokenFor(1));
    if (held === 'goal write')
      expect(goals.update).toHaveBeenCalledWith(
        outgoing.goals[0]!.id,
        expect.anything(),
        tokenFor(1),
      );
    expect(goals.update).toHaveBeenCalledTimes(held === 'goal write' ? 1 : 0);
    expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
  },
);

it('does not reconcile or remove a queued check-in from an earlier lifecycle of the same account', async () => {
  const queued = {
    goal_id: outgoing.goals[0]!.id!,
    did_complete: true,
    timestamp: '2026-10-14T12:00:00Z',
    operation_id: 'held-old-lifecycle',
    completed_units: 1,
  };
  await savePendingCheckIn(queued);
  jest.mocked(habits.listAll).mockResolvedValueOnce(serverRows());
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<typeof goalCompletions.create>>>();
  jest.mocked(goalCompletions.create).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const refreshing = habitManager.refreshHabits('UTC');
  await entered.promise;
  await adopt(2, incoming);
  await adopt(1, { ...outgoing, name: 'Current lifecycle row', streak: 3 });
  response.resolve({ streak: 9, day_units: 9, reason_code: 'logged', milestones: [] });
  expect(await refreshing).toBe(false);
  expect(useHabitStore.getState().habits[0]).toMatchObject({
    name: 'Current lifecycle row',
    streak: 3,
    completions: [],
  });
  expect((await loadHabits())?.[0]).toMatchObject({
    name: 'Current lifecycle row',
    streak: 3,
    completions: [],
  });
  expect(goalCompletions.create).toHaveBeenCalledWith(
    expect.objectContaining({ goal_id: queued.goal_id }),
    { token: tokenFor(1), idempotencyKey: 'log-unit:held-old-lifecycle' },
  );
  expect(await loadPendingCheckIns()).toEqual([queued]);
});

it.each(['prepare', 'remove'])(
  'does not %s an earlier lifecycle queue after a held storage read',
  async (kind) => {
    const old = { goal_id: 421, did_complete: true, timestamp: '2026-10-14T12:00:00Z' };
    const current = { ...old, goal_id: 3031 };
    await savePendingCheckIn(old);
    const scope = capturePendingCheckInScope();
    const originalRead = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
    const cached = await originalRead(scope.key);
    const entered = deferred<void>();
    const read = deferred<string | null>();
    jest.mocked(AsyncStorage.getItem).mockImplementation((key) => {
      if (key !== scope.key) return originalRead(key);
      entered.resolve();
      return read.promise;
    });
    const operation =
      kind === 'prepare' ? loadPendingCheckIns(scope, true) : removePendingCheckIns([old], scope);
    await entered.promise;
    await adopt(2, incoming);
    await adopt(1, returning);
    // The previous lane is held, so install the incoming lifecycle snapshot
    // directly as an independently completed cache read would do.
    await AsyncStorage.setItem(scope.key, JSON.stringify([current]));
    read.resolve(cached);
    await operation;
    jest.mocked(AsyncStorage.getItem).mockImplementation(originalRead);
    expect(await loadPendingCheckIns()).toEqual([current]);
  },
);

it.each(['retry write', 'retry clear', 'quarantine'])(
  'does not apply an old %s waiting in a storage lane to a new lifecycle',
  async (kind) => {
    const base =
      kind === 'quarantine'
        ? '@adepthood/dropped_checkins'
        : '@adepthood/pending_checkin_replay_state';
    const key = scopedKey(base);
    const held = deferred<void>();
    const entered = deferred<void>();
    const blocking = serialize(key, async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    const state = {
      identity: 'current-operation',
      attempts: 1,
      first_rejected_at: '2026-10-14T12:00:00Z',
      last_status: 500,
    };
    const dropped = {
      goal_id: 421,
      did_complete: true,
      timestamp: '2026-10-14T12:00:00Z',
      status: 404,
      reason: 'rejected' as const,
      dropped_at: '2026-10-14T12:00:00Z',
    };
    const operation =
      kind === 'retry write'
        ? saveCheckInReplayState({ ...state, identity: 'outgoing-operation' })
        : kind === 'retry clear'
          ? clearCheckInReplayState()
          : recordDroppedCheckIn(dropped);
    await adopt(2, incoming);
    await adopt(1, returning);
    await AsyncStorage.setItem(key, JSON.stringify(kind === 'quarantine' ? [] : state));
    held.resolve();
    await blocking;
    await operation;
    if (kind === 'quarantine') expect(await loadDroppedCheckIns()).toEqual([]);
    else expect(await loadCheckInReplayState()).toEqual(state);
  },
);
