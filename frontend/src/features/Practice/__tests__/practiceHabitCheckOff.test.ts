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

import { checkOffPracticeHabit, elapsedMinutesOf } from '../practiceHabitCheckOff';
import { practiceCheckedOffToast } from '../practiceHabitCopy';

import type { ToastConfig } from '@/components/Toast';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { useHabitStore } from '@/store/useHabitStore';

const TZ = 'UTC';
const HABIT_ID = 42;
const LOW_TARGET = 10;
const TWENTY_MINUTES = 20;
const NOW = new Date('2026-09-27T09:30:00Z');
const MS_PER_MINUTE = 60_000;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 101 : tier === 'clear' ? 102 : 103,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? LOW_TARGET : tier === 'clear' ? 20 : 30,
  target_unit: 'minutes',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (unit = 'minutes', overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Sit',
  icon: '🪷',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: (['low', 'clear', 'stretch'] as const).map((tier) =>
    makeGoal(tier, { target_unit: unit }),
  ),
  completions: [],
  revealed: true,
  ...overrides,
});

const serverResult = () => ({
  streak: 1,
  milestones: [],
  reason_code: 'units_adjusted',
  day_units: TWENTY_MINUTES,
});

let showToast: jest.Mock<(_config: ToastConfig) => void>;

const run = (overrides: Partial<Parameters<typeof checkOffPracticeHabit>[0]> = {}) =>
  checkOffPracticeHabit({
    habitId: HABIT_ID,
    elapsedMinutes: TWENTY_MINUTES,
    tz: TZ,
    showToast,
    now: () => NOW,
    ...overrides,
  });

const postedUnits = (): unknown =>
  (mockCreate.mock.calls[0] as [Record<string, unknown>])[0].completed_units;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(serverResult());
  showToast = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  useHabitStore.getState().setHabits([makeHabit()]);
  jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('elapsedMinutesOf — the session window, to the nearest minute', () => {
  const at = (ms: number): string => new Date(ms).toISOString();

  it('reads the minutes between started_at and ended_at', () => {
    expect(elapsedMinutesOf({ started_at: at(0), ended_at: at(20 * MS_PER_MINUTE) })).toBe(20);
  });

  it('rounds to the nearest minute, as the writing timer does', () => {
    expect(elapsedMinutesOf({ started_at: at(0), ended_at: at(20.4 * MS_PER_MINUTE) })).toBe(20);
    expect(elapsedMinutesOf({ started_at: at(0), ended_at: at(20.6 * MS_PER_MINUTE) })).toBe(21);
    expect(elapsedMinutesOf({ started_at: at(0), ended_at: at(20_000) })).toBe(0);
  });

  it('reads an unparseable window as no minutes, rather than throwing', () => {
    expect(elapsedMinutesOf({ started_at: 'nonsense', ended_at: at(0) })).toBe(0);
  });
});

describe('checkOffPracticeHabit', () => {
  it('credits a minute habit with the session’s minutes, through the logUnit pipeline, and says so', async () => {
    const prepare = jest.spyOn(habitManager, 'prepareLogUnit');
    const reconcile = jest.spyOn(habitManager, 'reconcileLogUnitContext');

    await run();

    expect(habitManager.refreshHabits).toHaveBeenCalledWith(TZ);
    expect(prepare).toHaveBeenCalledWith(HABIT_ID, TWENTY_MINUTES, TZ, NOW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(postedUnits()).toBe(TWENTY_MINUTES);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0].message).toBe(practiceCheckedOffToast('Sit'));
  });

  it('credits a habit counted in sessions with one', async () => {
    useHabitStore.getState().setHabits([makeHabit('sessions')]);

    await run();

    expect(postedUnits()).toBe(1);
  });

  it('credits a habit in some other unit with the gap to its low target', async () => {
    useHabitStore.getState().setHabits([makeHabit('pages')]);

    await run();

    expect(postedUnits()).toBe(LOW_TARGET);
  });

  it('a session that rounded to no minutes credits a minute habit nothing', async () => {
    await run({ elapsedMinutes: 0 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a linked habit that is locked goes quiet', async () => {
    useHabitStore.getState().setHabits([makeHabit('minutes', { revealed: false })]);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a linked habit that no longer exists posts nothing and throws nothing', async () => {
    useHabitStore.getState().setHabits([]);

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('posts nothing when the server’s habits cannot be read', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockResolvedValue(false);

    await run();

    expect(mockCreate).not.toHaveBeenCalled();
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

  it('a read that throws is swallowed, never surfaced', async () => {
    jest.spyOn(habitManager, 'refreshHabits').mockRejectedValue(new Error('boom'));

    await expect(run()).resolves.toBeUndefined();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
