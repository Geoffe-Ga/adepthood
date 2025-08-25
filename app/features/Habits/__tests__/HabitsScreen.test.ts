/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_COLORS } from '../../../constants/stageColors';
import type { Habit, Goal } from '../Habits.types';
import {
  calculateHabitProgress,
  calculateProgressPercentage,
  getGoalTier,
  getProgressBarColor,
  getMarkerPositions,
  clampPercentage,
} from '../HabitUtils';

describe('habit progress utilities', () => {
  const additiveGoals: Goal[] = [
    {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 1,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 2,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 3,
      target_unit: 'units',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ];

  const subtractiveGoals: Goal[] = [
    {
      id: 4,
      tier: 'low',
      title: 'low',
      target: 300,
      target_unit: 'mg',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    },
    {
      id: 5,
      tier: 'clear',
      title: 'clear',
      target: 200,
      target_unit: 'mg',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    },
    {
      id: 6,
      tier: 'stretch',
      title: 'stretch',
      target: 0,
      target_unit: 'mg',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    },
  ];

  it('sums completion units for habit progress', () => {
    const habit: Habit = {
      id: 1,
      stage: 'Beige',
      name: 'Test',
      icon: '🔥',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [
        { id: 1, timestamp: new Date(), completed_units: 1 },
        { id: 2, timestamp: new Date(), completed_units: 2.5 },
      ],
    };

    expect(calculateHabitProgress(habit)).toBeCloseTo(3.5);
  });

  it('offsets progress percentage after clear goal for additive habits', () => {
    const habit: Habit = {
      id: 2,
      stage: 'Beige',
      name: 'Additive',
      icon: '🔥',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [{ id: 1, timestamp: new Date(), completed_units: 2 }],
    };

    const { currentGoal, nextGoal } = getGoalTier(habit);
    const percentage = calculateProgressPercentage(habit, currentGoal, nextGoal);
    expect(percentage).toBeCloseTo(33);
  });

  it('calculates progress percentage for subtractive habits', () => {
    const habit: Habit = {
      id: 3,
      stage: 'Blue',
      name: 'Subtractive',
      icon: '❄️',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: subtractiveGoals,
      completions: [{ id: 1, timestamp: new Date(), completed_units: 150 }],
    };

    const { currentGoal, nextGoal } = getGoalTier(habit);
    const percentage = calculateProgressPercentage(habit, currentGoal, nextGoal);
    expect(percentage).toBeCloseTo(50);
  });

  it('returns the stage color for progress bars', () => {
    const habit: Habit = {
      id: 4,
      stage: 'Blue',
      name: 'Subtractive',
      icon: '❄️',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: subtractiveGoals,
      completions: [],
    };

    expect(getProgressBarColor(habit)).toBe(STAGE_COLORS[habit.stage]);
  });

  it('clamps percentage values between 0 and 100', () => {
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(-20)).toBe(0);
  });

  it('computes marker positions for additive goals', () => {
    const [low, clear, stretch] = additiveGoals;
    const pos = getMarkerPositions(low, clear, stretch);
    expect(pos.low).toBeCloseTo(50);
    expect(pos.clear).toBe(100);
  });

  it('computes marker positions for subtractive goals', () => {
    const [low, clear, stretch] = subtractiveGoals;
    const pos = getMarkerPositions(low, clear, stretch);
    expect(pos.low).toBe(100);
    expect(pos.stretch).toBe(0);
    expect(pos.clear).toBeGreaterThan(0);
  });
});
