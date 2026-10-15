import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

import { goalCompletions, habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import {
  loadHabits,
  loadPendingCheckIns,
  recordDroppedCheckIn,
  saveHabits,
  savePendingCheckIn,
} from '@/storage/habitStorage';
import { setActiveUser } from '@/storage/userScope';
import { useDroppedCheckInStore } from '@/store/useDroppedCheckInStore';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { create: jest.fn(), listAll: jest.fn() },
  goalCompletions: { create: jest.fn() },
}));
const row = (id: number, name: string): Habit => ({
  id,
  name,
  icon: '★',
  stage: 'Beige',
  streak: 0,
  revealed: true,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01'),
  completions: [],
  goals: [
    {
      id: id * 10 + 1,
      title: 'Low',
      tier: 'low',
      target: 1,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: id * 10 + 2,
      title: 'Clear',
      tier: 'clear',
      target: 2,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: id * 10 + 3,
      title: 'Stretch',
      tier: 'stretch',
      target: 3,
      target_unit: 'sessions',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
});
const existing = row(42, 'Existing sitting');
const created = row(303, 'New walk');
const rows = () =>
  [existing, created].map((habit) => ({ ...habit, start_date: '2026-01-01' })) as Awaited<
    ReturnType<typeof habits.listAll>
  >;
const token = `e30.${btoa(JSON.stringify({ sub: '1', exp: 4_000_000_000 }))}.sig`;
const originalWrite = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  setActiveUser(1);
  setTokenGetter(() => token);
  useHabitStore.setState({ habits: [existing], loading: false, error: null });
  useDroppedCheckInStore.getState().setEntries([]);
  await saveHabits([existing]);
  jest.mocked(habits.create).mockReset().mockResolvedValue(rows()[1]!);
  jest.mocked(habits.listAll).mockReset().mockResolvedValue(rows());
  jest
    .mocked(goalCompletions.create)
    .mockReset()
    .mockResolvedValue({ streak: 2, day_units: 2, milestones: [], reason_code: 'logged' });
});
afterEach(() => {
  jest.mocked(AsyncStorage.setItem).mockImplementation(originalWrite);
  setActiveUser(null);
  setTokenGetter(null);
});

it('delivers queued check-ins and hydrates their saved loss notice after a successful add', async () => {
  await savePendingCheckIn({
    goal_id: 421,
    did_complete: true,
    timestamp: '2026-10-14T12:00:00Z',
    operation_id: 'pending-before-create',
    completed_units: 1,
  });
  const dropped = {
    goal_id: 421,
    did_complete: true,
    timestamp: '2026-10-13T12:00:00Z',
    dropped_at: '2026-10-13T12:00:00Z',
    reason: 'rejected' as const,
    status: 404,
  };
  await recordDroppedCheckIn(dropped);
  await habitManager.addHabit({ name: created.name, icon: created.icon }, false, 'UTC');
  expect(goalCompletions.create).toHaveBeenCalledTimes(1);
  expect(await loadPendingCheckIns()).toEqual([]);
  expect(useHabitStore.getState().habits.find((habit) => habit.id === 42)?.completions).toEqual([
    expect.objectContaining({ completed_units: 2 }),
  ]);
  expect(useDroppedCheckInStore.getState().entries).toEqual([dropped]);
});

it('does not report the add settled until confirmed server ids are on disk', async () => {
  const entered = deferred<void>();
  const held = deferred<void>();
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    if (
      key === '@adepthood/habits#u1' &&
      (JSON.parse(value) as Habit[]).some((habit) => habit.id === 303)
    ) {
      entered.resolve();
      await held.promise;
    }
    await originalWrite(key, value);
  });
  let settled = false;
  const saving = habitManager
    .addHabit({ name: created.name, icon: created.icon }, false, 'UTC')
    .then(() => {
      settled = true;
    });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeDisk = settled;
  held.resolve();
  await saving;
  expect(settledBeforeDisk).toBe(false);
  expect((await loadHabits())?.map((habit) => habit.id)).toEqual([42, 303]);
});

it('clears an earlier load failure when the newly created server list is confirmed', async () => {
  useHabitStore.setState({ error: 'Earlier load failed; retry when connected.' });
  await habitManager.addHabit({ name: created.name, icon: created.icon }, false, 'UTC');
  expect(useHabitStore.getState().error).toBeNull();
  expect(useHabitStore.getState().habits.map((habit) => habit.id)).toEqual([42, 303]);
});

it('explains a failed confirmed-id cache write without an unhandled rejection or a false server failure', async () => {
  useHabitStore.setState({ error: 'Earlier load failed.' });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    if (
      key === '@adepthood/habits#u1' &&
      (JSON.parse(value) as Habit[]).some((habit) => habit.id === 303)
    )
      throw new Error('device cache full');
    await originalWrite(key, value);
  });
  await expect(
    habitManager.addHabit({ name: created.name, icon: created.icon }, false, 'UTC'),
  ).resolves.toBeUndefined();
  expect(alert).toHaveBeenCalledWith(
    "Couldn't sync",
    expect.stringContaining('saved on the server'),
  );
  expect(alert.mock.calls[0]?.[1]).toContain("couldn't save its confirmed details on this device");
  expect(useHabitStore.getState().error).toBeNull();
  expect(useHabitStore.getState().habits.map((habit) => habit.id)).toEqual([42, 303]);
  expect((await loadHabits())?.some((habit) => habit.id === 303)).toBe(false);
  alert.mockRestore();
});
