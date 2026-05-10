/* eslint-env jest */
/* global describe, test, expect */
import { validate as uuidValidate } from 'uuid';

import type { Habit, Goal } from '../Habits.types';
import {
  getProgressPercentage,
  getMarkerPositions,
  getGoalTier,
  calculateHabitProgress,
  logHabitUnits,
  calculateHabitStartDate,
  STAGE_DURATIONS_DAYS,
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
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 7 }],
    };
    const { currentGoal } = getGoalTier(habit);
    expect(getProgressPercentage(habit, currentGoal)).toBe(100);
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
      completions: [{ id: 'c-2', timestamp: new Date(), completed_units: 6 }],
    };
    const { currentGoal } = getGoalTier(habit);
    const pct = getProgressPercentage(habit, currentGoal);
    expect(Math.round(pct)).toBe(50);
  });

  // Pins the missing-stretch fallback: ``stretchGoal ?? currentGoal``.
  test('getProgressPercentage falls back to currentGoal when stretch is missing (additive)', () => {
    const lowOnly: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 4,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const habit: Habit = {
      ...baseHabit,
      goals: [lowOnly],
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 2 }],
    };
    // No stretch → fallback to ``lowOnly`` as the scale; 2 / 4 = 50%.
    expect(getProgressPercentage(habit, lowOnly)).toBeCloseTo(50);
  });

  // All three markers on the unified 0-100 bar (previous logic collapsed CG/SG to 100).
  test('getMarkerPositions additive places all three on a stretch-anchored scale', () => {
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
    // 2/6 ≈ 33.3, 4/6 ≈ 66.7, stretch always at 100.
    expect(pos.low).toBeCloseTo(33.33, 1);
    expect(pos.clear).toBeCloseTo(66.67, 1);
    expect(pos.stretch).toBe(100);
    // Strictly increasing — guards against a CG/SG-collapsed regression.
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });

  test('getMarkerPositions subtractive places all three on a low-anchored scale', () => {
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
    // (10-5)/(10-2) × 100 = 62.5 — CG between LG (failure) and SG (best).
    expect(pos.low).toBe(0);
    expect(pos.clear).toBeCloseTo(62.5, 1);
    expect(pos.stretch).toBe(100);
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });

  test('getMarkerPositions returns zeros when any tier is missing', () => {
    const onlyLow: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 1,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    expect(getMarkerPositions(onlyLow, undefined, undefined)).toEqual({
      low: 0,
      clear: 0,
      stretch: 0,
    });
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

  test('STAGE_DURATIONS_DAYS sums to 36 weeks (252 days)', () => {
    expect(STAGE_DURATIONS_DAYS).toHaveLength(10);
    const totalDays = STAGE_DURATIONS_DAYS.reduce((sum, d) => sum + d, 0);
    expect(totalDays).toBe(36 * 7);
  });

  test('calculateHabitStartDate offsets correctly', () => {
    const base = new Date('2024-01-01');
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 8; i++) {
      const result = calculateHabitStartDate(base, i);
      expect((result.getTime() - base.getTime()) / day).toBe(21 * i);
    }
    const ninth = calculateHabitStartDate(base, 8);
    expect((ninth.getTime() - base.getTime()) / day).toBe(168);
    const tenth = calculateHabitStartDate(base, 9);
    expect((tenth.getTime() - base.getTime()) / day).toBe(210);
  });

  test('logHabitUnits generates valid UUID string IDs for completions', () => {
    let habit: Habit = { ...baseHabit, goals: [], completions: [], streak: 0 };
    habit = logHabitUnits(habit, 1);
    const completion = habit.completions![0]!;
    expect(typeof completion.id).toBe('string');
    expect(uuidValidate(completion.id!)).toBe(true);
  });

  test('logHabitUnits generates unique IDs for each completion', () => {
    let habit: Habit = { ...baseHabit, goals: [], completions: [], streak: 0 };
    habit = logHabitUnits(habit, 1, new Date('2023-01-01'));
    habit = logHabitUnits(habit, 2, new Date('2023-01-02'));
    const ids = habit.completions!.map((c) => c.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(uuidValidate(ids[0]!)).toBe(true);
    expect(uuidValidate(ids[1]!)).toBe(true);
  });
});
