import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import type { ApiHabit } from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { getActiveUser, setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), listAll: jest.fn() },
}));
jest.mock('@/features/Habits/hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(async () => []),
  cancelForHabit: jest.fn(async () => {}),
}));
function deferred<T>() {
  let resolve!: (_value: T) => void;
  let reject!: (_reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function habit(id: number, name: string): Habit {
  return {
    id,
    name,
    stage: 'Beige',
    icon: '🧘',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    revealed: true,
    start_date: new Date('2026-10-01T00:00:00Z'),
    completions: [],
    goals: [
      {
        id: id * 10 + 1,
        title: 'Low',
        tier: 'low',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
      {
        id: id * 10 + 2,
        title: 'Clear',
        tier: 'clear',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
      {
        id: id * 10 + 3,
        title: 'Stretch',
        tier: 'stretch',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
    ],
  };
}
const outgoing = habit(101, 'Outgoing owner habit');
const incoming = habit(202, 'Incoming owner habit');
async function adopt(owner: number, row: Habit): Promise<void> {
  setActiveUser(owner);
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
  jest.mocked(habits.update).mockResolvedValue({} as ApiHabit);
  jest.mocked(habits.delete).mockResolvedValue(undefined);
  jest.mocked(habits.listAll).mockResolvedValue([]);
  setTokenGetter(() => {
    const owner = getActiveUser();
    return owner === null
      ? null
      : `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4102444800 }))}.signature`;
  });
  await adopt(1, outgoing);
});
afterEach(() => {
  setTokenGetter(() => null);
  setActiveUser(null);
});

it('preserves the incoming owner store AND scoped disk when the outgoing create rejects', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  expect(habits.create).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner create failure'));
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
it('never issues outgoing sibling PUTs under the incoming owner after the create resolves', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const writes: unknown[] = [];
  jest.mocked(habits.update).mockImplementation(async (id) => {
    writes.push({ id, owner: getActiveUser() });
    return {} as ApiHabit;
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await adopt(2, incoming);
  response.resolve({ id: 333 } as ApiHabit);
  await saving;
  expect(writes).toEqual([]);
});
it('never compensates an outgoing create with DELETE under the incoming owner', async () => {
  jest.mocked(habits.create).mockResolvedValueOnce({ id: 333 } as ApiHabit);
  const started = deferred<void>();
  const placement = deferred<ApiHabit>();
  jest.mocked(habits.update).mockImplementationOnce(() => {
    started.resolve();
    return placement.promise;
  });
  const deletes: unknown[] = [];
  jest.mocked(habits.delete).mockImplementation(async (id) => {
    deletes.push({ id, owner: getActiveUser() });
  });
  const saving = habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  await started.promise;
  await adopt(2, incoming);
  placement.reject(new Error('controlled old-owner placement failure'));
  await saving;
  expect(deletes).toEqual([]);
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
it('a same-owner failed create still restores its own previous store and disk', async () => {
  jest.mocked(habits.create).mockRejectedValueOnce(new Error('controlled same-owner failure'));
  await habitManager.insertHabitAtWithId({ name: 'New sitting', icon: '🧘' }, 1, 'UTC');
  expect(await snapshot()).toEqual({ memory: [101], disk: [101] });
});

it('addHabit preserves the incoming owner store AND scoped disk on a late create rejection', async () => {
  const response = deferred<ApiHabit>();
  jest.mocked(habits.create).mockReturnValueOnce(response.promise);
  const saving = habitManager.addHabit({ name: 'New sitting', icon: '🧘' }, false, 'UTC');
  expect(habits.create).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner add failure'));
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('an existing delete rollback closure cannot restore outgoing rows into the incoming account', async () => {
  const response = deferred<void>();
  jest.mocked(habits.delete).mockReturnValueOnce(response.promise);
  habitManager.deleteHabit(outgoing.id);
  expect(habits.delete).toHaveBeenCalledTimes(1);
  await adopt(2, incoming);
  response.reject(new Error('controlled old-owner delete failure'));
  await response.promise.catch(() => undefined);
  await Promise.resolve();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('an actual prepared and applied log context cannot roll outgoing rows into the incoming account', async () => {
  const ctx = habitManager.prepareLogUnit(outgoing.id, 1, 'UTC');
  expect(ctx).not.toBeNull();
  if (!ctx) throw new Error('the log ownership control requires a real prepared context');
  habitManager.applyLogUnitContext(ctx);
  expect(useHabitStore.getState().habits[0]?.completions).toHaveLength(1);
  await adopt(2, incoming);
  habitManager.rollbackLogUnitContext(ctx);
  await Promise.resolve();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});
