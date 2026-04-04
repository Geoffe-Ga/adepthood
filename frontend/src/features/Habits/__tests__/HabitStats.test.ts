/* eslint-env jest */
/* global describe, test, expect */
import type { Habit, Goal } from '../Habits.types';
import { generateStatsForHabit, calculateMissedDays } from '../HabitUtils';

describe('generateStatsForHabit', () => {
  const goals: Goal[] = [
    {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 2,
      target_unit: 'cups',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 4,
      target_unit: 'cups',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 6,
      target_unit: 'cups',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ];

  const baseHabit: Habit = {
    id: 1,
    stage: 'Beige',
    name: 'Water',
    icon: '💧',
    streak: 3,
    energy_cost: 1,
    energy_return: 2,
    start_date: new Date('2024-01-01'),
    goals,
    completions: [],
  };

  test('returns zeroed stats when there are no completions', () => {
    const stats = generateStatsForHabit(baseHabit);
    expect(stats.totalCompletions).toBe(0);
    expect(stats.longestStreak).toBe(0);
    expect(stats.completionRate).toBe(0);
    expect(stats.values).toHaveLength(7);
    expect(stats.values.every((v) => v === 0)).toBe(true);
  });

  test('groups completions by day of week', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        // Monday 2024-01-01
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 2 },
        // Monday 2024-01-01 (second log same day)
        { id: 2, timestamp: new Date('2024-01-01T12:00:00'), completed_units: 1 },
        // Wednesday 2024-01-03
        { id: 3, timestamp: new Date('2024-01-03T10:00:00'), completed_units: 3 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    // values should reflect total units per day-of-week
    // Mon=3, Tue=0, Wed=3, Thu=0, Fri=0, Sat=0, Sun=0
    expect(stats.values[1]).toBe(3); // Monday index 1
    expect(stats.values[3]).toBe(3); // Wednesday index 3
    expect(stats.totalCompletions).toBe(3);
  });

  test('calculates longest streak from consecutive calendar days', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 2, timestamp: new Date('2024-01-02T08:00:00'), completed_units: 1 },
        { id: 3, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
        // gap on Jan 4
        { id: 4, timestamp: new Date('2024-01-05T08:00:00'), completed_units: 1 },
        { id: 5, timestamp: new Date('2024-01-06T08:00:00'), completed_units: 1 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    expect(stats.longestStreak).toBe(3);
  });

  test('calculates completion rate as days-with-completions / total-days', () => {
    const habit: Habit = {
      ...baseHabit,
      start_date: new Date('2024-01-01'),
      completions: [
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 2, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    // From Jan 1 to Jan 3 = 3 days span, completed on 2 of them
    const stats = generateStatsForHabit(habit);
    expect(stats.completionRate).toBeCloseTo(2 / 3, 1);
  });

  test('completionsByDay is 1/0 per day of week', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        // Monday
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 2 },
        // Wednesday
        { id: 2, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 3 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    expect(stats.completionsByDay[1]).toBe(1); // Monday
    expect(stats.completionsByDay[2]).toBe(0); // Tuesday
    expect(stats.completionsByDay[3]).toBe(1); // Wednesday
  });
});

describe('calculateMissedDays', () => {
  const goals: Goal[] = [
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

  const baseHabit: Habit = {
    id: 1,
    stage: 'Beige',
    name: 'Test',
    icon: '🔥',
    streak: 0,
    energy_cost: 0,
    energy_return: 0,
    start_date: new Date('2024-01-01'),
    goals,
    completions: [],
  };

  test('returns empty array when there are no completions', () => {
    const missed = calculateMissedDays(baseHabit);
    expect(missed).toEqual([]);
  });

  test('identifies days without completions between first and last completion', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 2, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const missed = calculateMissedDays(habit);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.toISOString().slice(0, 10)).toBe('2024-01-02');
  });

  test('returns empty array when all days have completions', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 2, timestamp: new Date('2024-01-02T08:00:00'), completed_units: 1 },
        { id: 3, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const missed = calculateMissedDays(habit);
    expect(missed).toHaveLength(0);
  });

  test('handles multiple completions on the same day', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 1, timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 2, timestamp: new Date('2024-01-01T12:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 3, timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const missed = calculateMissedDays(habit);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.toISOString().slice(0, 10)).toBe('2024-01-02');
  });
});
