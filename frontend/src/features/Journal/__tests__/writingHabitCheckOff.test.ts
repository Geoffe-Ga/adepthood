/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockCreate = jest.fn<(..._args: unknown[]) => Promise<unknown>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, goalCompletions: { create: (...args: unknown[]) => mockCreate(...args) } };
});

import { checkedOffToast } from '../saveAsHabitCopy';
import {
  MIN_CHECK_OFF_ELAPSED_MS,
  checkOffLinkedHabit,
  isLinkableHabit,
} from '../writingHabitCheckOff';

import type { ToastConfig } from '@/components/Toast';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { useHabitStore } from '@/store/useHabitStore';

const TZ = 'UTC';
const HABIT_ID = 42;
const LOW_TARGET = 2;
const ELAPSED_MS = 60_000;
const ELAPSED_MINUTES = 1;
const TWENTY_MINUTES = 20;
const NOW = new Date('2026-09-27T09:30:00Z');
const SERVER_DAY_UNITS = LOW_TARGET;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 101 : tier === 'clear' ? 102 : 103,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? LOW_TARGET : tier === 'clear' ? 4 : 6,
  target_unit: 'pages',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Morning pages',
  icon: '✍️',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

const SERVER_READ = async (): Promise<boolean> => true;

const withTodayUnits = (units: number): Habit =>
  makeHabit({ completions: [{ id: 't-1', timestamp: new Date(), completed_units: units }] });

/** The habit the bug report named: "Journal", measured in minutes, 10 / 20 / 30. */
const minuteHabit = (todayUnits = 0): Habit =>
  makeHabit({
    name: 'Journal',
    goals: (['low', 'clear', 'stretch'] as const).map((tier, index) =>
      makeGoal(tier, { target_unit: 'minutes', target: (index + 1) * 10 }),
    ),
    completions:
      todayUnits > 0 ? [{ id: 't-1', timestamp: new Date(), completed_units: todayUnits }] : [],
  });

const serverResult = (dayUnits = SERVER_DAY_UNITS) => ({
  streak: 1,
  milestones: [],
  reason_code: 'units_adjusted',
  day_units: dayUnits,
});

let showToast: jest.Mock<(_config: ToastConfig) => void>;

const run = (overrides: Partial<Parameters<typeof checkOffLinkedHabit>[0]> = {}) =>
  checkOffLinkedHabit({
    habitId: HABIT_ID,
    elapsedMs: ELAPSED_MS,
    elapsedMinutes: ELAPSED_MINUTES,
    tz: TZ,
    showToast,
    now: () => NOW,
    ...overrides,
  });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(serverResult());
  showToast = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  useHabitStore.getState().setHabits([makeHabit()]);
  // The server agrees with the store unless a test says otherwise.
  jest.spyOn(habitManager, 'refreshHabits').mockImplementation(SERVER_READ);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('isLinkableHabit — the shared gate, re-exported for the picker', () => {
  it('admits an additive, server-backed habit with all three tiers', () => {
    expect(isLinkableHabit(makeHabit())).toBe(true);
  });

  it('refuses a locked habit: nothing can be logged against one until it is open', () => {
    expect(isLinkableHabit(makeHabit({ revealed: false }))).toBe(false);
  });
});

describe('checkOffLinkedHabit', () => {
  it('posts the low gap through the logUnit pipeline, dated now, and says so', async () => {
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');
    const reconcile = jest.spyOn(habitManager, 'reconcileLogUnitContext');

    await run();

    expect(prepare).toHaveBeenCalledWith(HABIT_ID, LOW_TARGET, TZ, NOW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [payload, options] = mockCreate.mock.calls[0] as [
      Record<string, unknown>,
      { idempotencyKey?: string },
    ];
    expect(payload).toEqual({
      goal_id: 101,
      did_complete: true,
      completed_on: undefined,
      completed_units: LOW_TARGET,
    });
    expect(options.idempotencyKey).toMatch(/^log-unit:/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0].message).toBe(checkedOffToast('Morning pages'));
  });

  it('a second finished session the same day posts nothing: the habit is already checked off', async () => {
    await run();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    await run();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('a habit measured in minutes is credited the minutes written, not the gap to low', async () => {
    useHabitStore.getState().setHabits([minuteHabit()]);
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');

    await run({ elapsedMs: TWENTY_MINUTES * 60_000, elapsedMinutes: TWENTY_MINUTES });

    expect(prepare).toHaveBeenCalledWith(HABIT_ID, TWENTY_MINUTES, TZ, NOW);
    const [payload] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(payload.completed_units).toBe(TWENTY_MINUTES);
    expect(showToast.mock.calls[0]?.[0].message).toBe(checkedOffToast('Journal'));
  });

  it('a second session on a minute habit posts its own minutes again: they accumulate', async () => {
    useHabitStore.getState().setHabits([minuteHabit(TWENTY_MINUTES)]);

    await run({ elapsedMs: TWENTY_MINUTES * 60_000, elapsedMinutes: TWENTY_MINUTES });

    const [payload] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(payload.completed_units).toBe(TWENTY_MINUTES);
  });

  it('a minute habit is not credited by a session that rounded to no minutes', async () => {
    useHabitStore.getState().setHabits([minuteHabit()]);

    await run({ elapsedMs: 20_000, elapsedMinutes: 0 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a zero-length session checks nothing off', async () => {
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');

    await run({ elapsedMs: 0 });

    expect(prepare).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the shortest session that ran at all does check off a habit counted in pages', async () => {
    await run({ elapsedMs: MIN_CHECK_OFF_ELAPSED_MS, elapsedMinutes: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('loads the habits first when the linked one is not in the store', async () => {
    useHabitStore.getState().setHabits([]);
    const load = jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([makeHabit()]);
      return true;
    });

    await run();

    expect(load).toHaveBeenCalledWith(TZ);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a linked habit that no longer exists posts nothing and throws nothing', async () => {
    useHabitStore.getState().setHabits([]);
    jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(true);

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a habit that stopped being linkable (now subtractive) posts nothing', async () => {
    const goals = (['low', 'clear', 'stretch'] as const).map((tier) =>
      makeGoal(tier, { is_additive: false }),
    );
    useHabitStore.getState().setHabits([makeHabit({ goals })]);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a linked habit that is locked again goes quiet: no post and no toast', async () => {
    useHabitStore.getState().setHabits([makeHabit({ revealed: false })]);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reads the server’s day before posting, so another device’s check-off is not repeated', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([withTodayUnits(LOW_TARGET)]);
      return true;
    });

    await run();

    expect(habitManager.refreshHabits).toHaveBeenCalledWith(TZ);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('posts only the gap the server still shows', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockImplementation(async () => {
      useHabitStore.getState().setHabits([withTodayUnits(1)]);
      return true;
    });

    await run();

    const [payload] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(payload.completed_units).toBe(LOW_TARGET - 1);
  });

  it('posts nothing when the server’s day cannot be read', async () => {
    // The cache keeps the list on screen, so only the read's own answer says
    // this day is stale.
    jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(false);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a failed post rolls the optimistic row back, warns, and shows nothing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('offline'));
    const rollback = jest.spyOn(habitManager, 'rollbackLogUnitContext');
    const before = useHabitStore.getState().habits;

    await expect(run()).resolves.toBeUndefined();

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(useHabitStore.getState().habits).toEqual(before);
    expect(console.warn).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a commit that resolves no result shows no toast', async () => {
    jest.spyOn(habitManager, 'commitLogUnitContext').mockResolvedValueOnce(null);
    const reconcile = jest.spyOn(habitManager, 'reconcileLogUnitContext');

    await run();

    expect(reconcile).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a load that throws is swallowed, never surfaced to the writer', async () => {
    useHabitStore.getState().setHabits([]);
    jest.spyOn(habitManager, 'refreshHabits').mockRejectedValue(new Error('boom'));

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
