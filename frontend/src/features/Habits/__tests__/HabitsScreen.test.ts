/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_COLORS, VICTORY_COLOR } from '../../../design/tokens';
import type { Habit, Goal } from '../Habits.types';
import {
  calculateHabitProgress,
  getProgressPercentage,
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
        { id: 'c-1', timestamp: new Date(), completed_units: 1 },
        { id: 'c-2', timestamp: new Date(), completed_units: 2.5 },
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
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 2 }],
    };

    const { currentGoal, nextGoal } = getGoalTier(habit);
    const percentage = getProgressPercentage(habit, currentGoal, nextGoal);
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
      completions: [{ id: 'c-2', timestamp: new Date(), completed_units: 150 }],
    };

    const { currentGoal, nextGoal } = getGoalTier(habit);
    const percentage = getProgressPercentage(habit, currentGoal, nextGoal);
    expect(percentage).toBeCloseTo(50);
  });

  it('returns the stage color when goals are not met (additive)', () => {
    const habit: Habit = {
      id: 4,
      stage: 'Blue',
      name: 'Additive',
      icon: '🔥',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
    };

    expect(getProgressBarColor(habit)).toBe(STAGE_COLORS[habit.stage]);
  });

  it('returns victory color when clear goal is met (additive)', () => {
    const habit: Habit = {
      id: 5,
      stage: 'Blue',
      name: 'Additive',
      icon: '🔥',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 2 }],
    };

    expect(getProgressBarColor(habit)).toBe(VICTORY_COLOR);
  });

  it('returns victory color when under stretch target (subtractive)', () => {
    const habit: Habit = {
      id: 6,
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

    // No completions = 0 progress, which is <= stretch target (0) → victory
    expect(getProgressBarColor(habit)).toBe(VICTORY_COLOR);
  });

  it('returns stage color when stretch threshold is broken (subtractive)', () => {
    const habit: Habit = {
      id: 7,
      stage: 'Blue',
      name: 'Subtractive',
      icon: '❄️',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: subtractiveGoals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 150 }],
    };

    // 150 > stretch target (0) → stage color
    expect(getProgressBarColor(habit)).toBe(STAGE_COLORS[habit.stage]);
  });

  it('returns stage color for habit with no goals', () => {
    const habit: Habit = {
      id: 8,
      stage: 'Green',
      name: 'No Goals',
      icon: '🌿',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: [],
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
