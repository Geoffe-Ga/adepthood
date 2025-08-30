/* eslint-env jest */
/* global describe, test, expect */
import type { Habit, Goal } from '../Habits.types';
import {
  getProgressPercentage,
  getMarkerPositions,
  getGoalTier,
  calculateHabitProgress,
  logHabitUnits,
  calculateHabitStartDate,
} from '../HabitUtils';

describe('HabitUtils', () => {
  const baseHabit = {
    id: 1,
    name: 'Test',
    icon: '🔥',
    stage: 'Beige',
    streak: 0,
    energy_cost: 0,
    energy_return: 0,
    start_date: new Date(),
  } as const;

  test('getProgressPercentage additive clamps at 100', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 4,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 6,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ];
    const habit: Habit = {
      ...baseHabit,
      goals,
      completions: [{ id: 1, timestamp: new Date(), completed_units: 7 }],
    };
    const { currentGoal, nextGoal } = getGoalTier(habit);
    expect(getProgressPercentage(habit, currentGoal, nextGoal)).toBe(100);
  });

  test('getProgressPercentage subtractive returns proportion', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
    ];
    const habit: Habit = {
      ...baseHabit,
      goals,
      completions: [{ id: 1, timestamp: new Date(), completed_units: 6 }],
    };
    const { currentGoal, nextGoal } = getGoalTier(habit);
    const pct = getProgressPercentage(habit, currentGoal, nextGoal);
    expect(Math.round(pct)).toBe(50);
  });

  test('getMarkerPositions additive', () => {
    const low: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 2,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const clear: Goal = {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 4,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const stretch: Goal = {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 6,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const pos = getMarkerPositions(low, clear, stretch);
    expect(pos.low).toBeCloseTo(50);
    expect(pos.clear).toBe(100);
    expect(pos.stretch).toBe(100);
  });

  test('getMarkerPositions subtractive', () => {
    const low: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 10,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const clear: Goal = {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 5,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const stretch: Goal = {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 2,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const pos = getMarkerPositions(low, clear, stretch);
    expect(pos.low).toBe(100);
    expect(Math.round(pos.clear)).toBe(38);
    expect(pos.stretch).toBe(0);
  });

  test('logHabitUnits accumulates progress and increments streak once per day', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 15,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ];
    let habit: Habit = { ...baseHabit, goals, completions: [], streak: 0 };
    const day = new Date('2023-01-01T08:00:00');
    habit = logHabitUnits(habit, 3, day);
    expect(calculateHabitProgress(habit)).toBe(3);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 4, new Date('2023-01-01T12:00:00'));
    expect(calculateHabitProgress(habit)).toBe(7);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 2, new Date('2023-01-02T09:00:00'));
    expect(calculateHabitProgress(habit)).toBe(9);
    expect(habit.streak).toBe(2);
  });

  test('logHabitUnits supports subtractive habits', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
    ];
    let habit: Habit = { ...baseHabit, goals, completions: [], streak: 0 };
    habit = logHabitUnits(habit, 4, new Date('2023-01-01T08:00:00'));
    habit = logHabitUnits(habit, 3, new Date('2023-01-01T12:00:00'));
    expect(calculateHabitProgress(habit)).toBe(7);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 1, new Date('2023-01-02T09:00:00'));
    expect(habit.streak).toBe(2);
  });

  test('calculateHabitStartDate offsets correctly', () => {
    const base = new Date('2024-01-01');
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 8; i++) {
      const result = calculateHabitStartDate(base, i);
      expect((result.getTime() - base.getTime()) / day).toBe(21 * i);
    }
    const ninth = calculateHabitStartDate(base, 8);
    expect((ninth.getTime() - base.getTime()) / day).toBe(189);
    const tenth = calculateHabitStartDate(base, 9);
    expect((tenth.getTime() - base.getTime()) / day).toBe(231);
  });
});
