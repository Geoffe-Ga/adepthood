import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { JOURNAL_HABIT_DEFAULT_GOALS, writingGoalDraft } from '../journalHabitDefaults';
import { saveWritingHabitGoals } from '../writingHabitGoals';

import { goals, habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { updateGoalUnits: jest.fn(), listAll: jest.fn() },
  goals: { update: jest.fn() },
}));

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const tokenFor = (owner: number) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
const outgoing = (): Habit => ({
  ...writingGoalDraft(),
  id: 42,
  name: 'Outgoing page habit',
  goals: writingGoalDraft().goals.map((goal, index) => ({
    ...goal,
    id: 101 + index,
    target_unit: 'pages',
  })),
});
const incoming = (): Habit => ({ ...writingGoalDraft(), id: 202, name: 'Incoming account walk' });
const serverRows = () =>
  [{ ...writingGoalDraft(outgoing()), start_date: '2026-01-01' }] as Awaited<
    ReturnType<typeof habits.listAll>
  >;
async function adopt(owner: number, row: Habit): Promise<void> {
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
  jest.mocked(habits.updateGoalUnits).mockResolvedValue([]);
  jest.mocked(goals.update).mockResolvedValue({} as Awaited<ReturnType<typeof goals.update>>);
  jest.mocked(habits.listAll).mockReset();
  await adopt(1, outgoing());
});
afterEach(() => {
  jest.restoreAllMocks();
  setActiveUser(null);
  setTokenGetter(null);
});

it('refuses an outgoing token before writing goals in the incoming namespace', async () => {
  await adopt(2, incoming());
  jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(true);
  await saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', tokenFor(1)).catch(
    () => null,
  );
  expect(habits.updateGoalUnits).not.toHaveBeenCalled();
  expect(goals.update).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('never installs an outgoing confirmation into the incoming store or scoped disk', async () => {
  const response = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
  const entered = deferred<void>();
  jest.mocked(habits.listAll).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const saving = saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', tokenFor(1));
  await entered.promise;
  await adopt(2, incoming());
  response.resolve(serverRows());
  await saving;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('an existing direct habit refresh cannot hydrate the outgoing account into the incoming cache', async () => {
  const response = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
  const entered = deferred<void>();
  jest.mocked(habits.listAll).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const refreshing = habitManager.refreshHabits('UTC');
  await entered.promise;
  await adopt(2, incoming());
  response.resolve(serverRows());
  await refreshing;
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('confirms only the ladder while preserving check-ins and unrelated live habits', async () => {
  const completion = {
    id: 'live-check-in',
    timestamp: new Date('2026-10-14T12:00:00Z'),
    completed_units: 7,
  };
  jest.mocked(habits.listAll).mockImplementationOnce(async () => {
    useHabitStore.getState().setHabits([{ ...outgoing(), completions: [completion] }, incoming()]);
    return serverRows();
  });
  const confirmed = await saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC');
  expect(habits.listAll).toHaveBeenCalledWith(tokenFor(1));
  expect(confirmed?.completions).toEqual([completion]);
  expect(confirmed?.goals.map((goal) => goal.target)).toEqual([10, 20, 45]);
  expect(await snapshot()).toEqual({ memory: [42, 202], disk: [42, 202] });
  expect((await loadHabits())?.[0]?.completions).toEqual([completion]);
});

it('never resurrects a habit removed while its goals were being confirmed', async () => {
  jest.mocked(habits.listAll).mockImplementationOnce(async () => {
    useHabitStore.getState().setHabits([incoming()]);
    await saveHabits([incoming()]);
    return serverRows();
  });
  await expect(
    saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC'),
  ).resolves.toBeNull();
  expect(await snapshot()).toEqual({ memory: [202], disk: [202] });
});

it('does not revive a confirmation after the same account starts another lifecycle', async () => {
  const entered = deferred<void>();
  const response = deferred<Awaited<ReturnType<typeof habits.listAll>>>();
  jest.mocked(habits.listAll).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const saving = saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC');
  await entered.promise;
  await adopt(2, incoming());
  await adopt(1, { ...incoming(), id: 303 });
  response.resolve(serverRows());
  expect(await saving).toBeNull();
  expect(await snapshot()).toEqual({ memory: [303], disk: [303] });
});

it.each(['missing', 'another account'])(
  'refuses an explicit old token when the active credential is %s',
  async (kind) => {
    setTokenGetter(kind === 'missing' ? null : () => tokenFor(2));
    await saveWritingHabitGoals(outgoing(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', tokenFor(1)).catch(
      () => null,
    );
    expect(habits.updateGoalUnits).not.toHaveBeenCalled();
    expect(goals.update).not.toHaveBeenCalled();
    expect(habits.listAll).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual({ memory: [42], disk: [42] });
  },
);
