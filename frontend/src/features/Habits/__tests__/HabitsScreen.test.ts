/* eslint-env jest */
/* global describe, it, expect */
import { brightenColor, STAGE_COLORS } from '../../../design/tokens';
import type { Habit, Goal } from '../Habits.types';
import {
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

  it('reports additive progress against the stretch target on a unified 0-100 scale', () => {
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

    // 2 / 3 = 66.67% on the unified stretch-anchored scale.
    const { currentGoal } = getGoalTier(habit);
    const percentage = getProgressPercentage(habit, currentGoal);
    expect(percentage).toBeCloseTo(66.67, 1);
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

    const { currentGoal } = getGoalTier(habit);
    const percentage = getProgressPercentage(habit, currentGoal);
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

    expect(getProgressBarColor(habit)).toBe(brightenColor(STAGE_COLORS.Blue!));
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
    expect(getProgressBarColor(habit)).toBe(brightenColor(STAGE_COLORS.Blue!));
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

  it('uses the explicit stageColor argument when habit.stage is empty', () => {
    // Backend defaults habit.stage to "" (see backend/src/models/habit.py).
    // The tile resolves its color from list position, so getProgressBarColor
    // must honor that override instead of falling back to black.
    const habit: Habit = {
      id: 9,
      stage: '',
      name: 'Unstaged',
      icon: '✨',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
    };

    expect(getProgressBarColor(habit, undefined, STAGE_COLORS.Orange)).toBe(STAGE_COLORS.Orange);
  });

  it('brightens the explicit stageColor when the clear goal is met', () => {
    const habit: Habit = {
      id: 10,
      stage: '',
      name: 'Unstaged Achiever',
      icon: '⭐',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: additiveGoals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 2 }],
    };

    expect(getProgressBarColor(habit, undefined, STAGE_COLORS.Orange)).toBe(
      brightenColor(STAGE_COLORS.Orange!),
    );
  });

  it('clamps percentage values between 0 and 100', () => {
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(-20)).toBe(0);
  });

  it('computes marker positions for additive goals on the stretch-anchored scale', () => {
    const [low, clear, stretch] = additiveGoals;
    const pos = getMarkerPositions(low, clear, stretch);
    // low=1, clear=2, stretch=3 -- markers at 33, 67, 100 respectively.
    expect(pos.low).toBeCloseTo(33.33, 1);
    expect(pos.clear).toBeCloseTo(66.67, 1);
    expect(pos.stretch).toBe(100);
    // Distinct columns — pins the "always-visible" invariant.
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });

  it('computes marker positions for subtractive goals on the low-anchored scale', () => {
    const [low, clear, stretch] = subtractiveGoals;
    const pos = getMarkerPositions(low, clear, stretch);
    // low=300 (failure, 0%), stretch=0 (best, 100%), clear=200 → 33%.
    expect(pos.low).toBe(0);
    expect(pos.clear).toBeCloseTo(33.33, 1);
    expect(pos.stretch).toBe(100);
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });
});
