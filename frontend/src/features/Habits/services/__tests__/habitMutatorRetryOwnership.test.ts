import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { setOnUnauthorized, setTokenGetter } from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
jest.mock('@/features/Habits/hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(async () => []),
  cancelForHabit: jest.fn(async () => {}),
}));
const tokenFor = (owner: number) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
const outgoing: Habit = {
  id: 42,
  name: 'Outgoing row',
  icon: '★',
  stage: 'Beige',
  streak: 0,
  revealed: false,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01'),
  completions: [],
  goals: [
    {
      id: 421,
      title: 'Low',
      tier: 'low',
      target: 1,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 422,
      title: 'Clear',
      tier: 'clear',
      target: 2,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 423,
      title: 'Stretch',
      tier: 'stretch',
      target: 3,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
};
const incoming = { ...outgoing, id: 202, name: 'Incoming row' };
const originalFetch = globalThis.fetch;
const fetchMock = jest.fn<typeof fetch>();
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function adopt(owner: number, row: Habit) {
  setActiveUser(owner);
  setTokenGetter(() => tokenFor(owner));
  useHabitStore.getState().setHabits([row]);
  await saveHabits([row]);
}
beforeEach(async () => {
  await AsyncStorage.clear();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  setOnUnauthorized(null);
  await adopt(1, outgoing);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setActiveUser(null);
  setTokenGetter(null);
});
const operations = {
  habit: () => habitManager.updateHabit({ ...outgoing, name: 'Edited outgoing row' }, 'UTC'),
  delete: () => habitManager.deleteHabit(outgoing.id!),
  goal: () => habitManager.updateGoal(outgoing.id!, { ...outgoing.goals[0]!, target: 2 }),
  units: () => habitManager.updateGoalUnits(outgoing.id!, { target_unit: 'minutes' }),
  reveal: () => habitManager.revealAllHabits('UTC'),
};
for (const kind of Object.keys(operations) as (keyof typeof operations)[]) {
  it(`sends the same-account ${kind} with its initiating credential`, async () => {
    fetchMock.mockResolvedValueOnce(response({}));
    operations[kind]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${tokenFor(1)}`,
    );
  });
  it(`refuses the ${kind} before changing a mismatched account namespace`, async () => {
    await adopt(2, outgoing);
    setTokenGetter(() => tokenFor(1));
    fetchMock.mockResolvedValueOnce(response({}));
    operations[kind]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toEqual([outgoing]);
    expect((await loadHabits())?.map((row) => row.id)).toEqual([42]);
  });
}
it.each(['same account', 'incoming account'])(
  'keeps the retried DELETE credential pinned with %s',
  async (phase) => {
    const entered = deferred<void>();
    const held = deferred<Response>();
    const retried = deferred<void>();
    fetchMock
      .mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
      })
      .mockImplementationOnce(async () => {
        retried.resolve();
        return response({});
      });
    operations.delete();
    await entered.promise;
    if (phase === 'incoming account') await adopt(2, incoming);
    held.resolve(response({ detail: 'temporarily_unavailable' }, 503));
    await retried.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>).Authorization,
      ),
    ).toEqual([`Bearer ${tokenFor(1)}`, `Bearer ${tokenFor(1)}`]);
    if (phase === 'incoming account') {
      expect(useHabitStore.getState().habits).toEqual([incoming]);
      expect((await loadHabits())?.map((row) => row.id)).toEqual([202]);
    }
  },
);
