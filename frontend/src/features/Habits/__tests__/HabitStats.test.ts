/* eslint-env jest */
/* global describe, test, expect */
import type { Habit, Goal } from '../Habits.types';
import { generateStatsForHabit, toLocalHabitStats, calculateMissedDays } from '../HabitUtils';

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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 2 },
        // Monday 2024-01-01 (second log same day)
        { id: 'c-2', timestamp: new Date('2024-01-01T12:00:00'), completed_units: 1 },
        // Wednesday 2024-01-03
        { id: 'c-3', timestamp: new Date('2024-01-03T10:00:00'), completed_units: 3 },
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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 'c-2', timestamp: new Date('2024-01-02T08:00:00'), completed_units: 1 },
        { id: 'c-3', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
        // gap on Jan 4
        { id: 'c-4', timestamp: new Date('2024-01-05T08:00:00'), completed_units: 1 },
        { id: 'c-5', timestamp: new Date('2024-01-06T08:00:00'), completed_units: 1 },
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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 'c-2', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 2 },
        // Wednesday
        { id: 'c-2', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 3 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    expect(stats.completionsByDay[1]).toBe(1); // Monday
    expect(stats.completionsByDay[2]).toBe(0); // Tuesday
    expect(stats.completionsByDay[3]).toBe(1); // Wednesday
  });

  test('includes currentStreak counting from today backwards (BUG-FE-HABIT-207)', () => {
    // Anchor relative to "today" so the helper -- which now compares to
    // today/yesterday before counting -- returns a meaningful chain.
    const today = new Date();
    const dayAgo = new Date(today);
    dayAgo.setUTCDate(dayAgo.getUTCDate() - 1);
    const twoAgo = new Date(today);
    twoAgo.setUTCDate(twoAgo.getUTCDate() - 2);
    const fourAgo = new Date(today);
    fourAgo.setUTCDate(fourAgo.getUTCDate() - 4);

    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 'c-1', timestamp: fourAgo, completed_units: 1 }, // gap follows
        { id: 'c-2', timestamp: twoAgo, completed_units: 1 },
        { id: 'c-3', timestamp: dayAgo, completed_units: 1 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    // Yesterday + day-before = 2 (today not yet completed; yesterday-only is OK).
    expect(stats.currentStreak).toBe(2);
  });

  test('currentStreak is 0 when last completion is more than yesterday', () => {
    // Pin BUG-FE-HABIT-207 directly: a stale chain that ended a week
    // ago must not still report a non-zero streak.
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 'c-2', timestamp: new Date('2024-01-02T08:00:00'), completed_units: 1 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    expect(stats.currentStreak).toBe(0);
  });

  test('includes completionDates as ISO date strings', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 'c-2', timestamp: new Date('2024-01-01T12:00:00'), completed_units: 1 },
        { id: 'c-3', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const stats = generateStatsForHabit(habit);
    expect(stats.completionDates).toContain('2024-01-01');
    expect(stats.completionDates).toContain('2024-01-03');
    expect(stats.completionDates).toHaveLength(2);
  });
});

describe('toLocalHabitStats', () => {
  test('converts snake_case API response to camelCase HabitStatsData', () => {
    const api = {
      day_labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      values: [0, 3, 0, 3, 0, 0, 0],
      completions_by_day: [0, 1, 0, 1, 0, 0, 0],
      longest_streak: 3,
      current_streak: 2,
      total_completions: 5,
      completion_rate: 0.67,
      completion_dates: ['2024-01-01', '2024-01-03'],
    };
    const local = toLocalHabitStats(api);
    expect(local.dayLabels).toEqual(api.day_labels);
    expect(local.dates).toEqual(api.day_labels);
    expect(local.values).toEqual(api.values);
    expect(local.completionsByDay).toEqual(api.completions_by_day);
    expect(local.longestStreak).toBe(3);
    expect(local.currentStreak).toBe(2);
    expect(local.totalCompletions).toBe(5);
    expect(local.completionRate).toBe(0.67);
    expect(local.completionDates).toEqual(['2024-01-01', '2024-01-03']);
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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 'c-2', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
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
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 'c-2', timestamp: new Date('2024-01-02T08:00:00'), completed_units: 1 },
        { id: 'c-3', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const missed = calculateMissedDays(habit);
    expect(missed).toHaveLength(0);
  });

  test('handles multiple completions on the same day', () => {
    const habit: Habit = {
      ...baseHabit,
      completions: [
        { id: 'c-1', timestamp: new Date('2024-01-01T08:00:00'), completed_units: 1 },
        { id: 'c-2', timestamp: new Date('2024-01-01T12:00:00'), completed_units: 1 },
        // gap on Jan 2
        { id: 'c-3', timestamp: new Date('2024-01-03T08:00:00'), completed_units: 1 },
      ],
    };
    const missed = calculateMissedDays(habit);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.toISOString().slice(0, 10)).toBe('2024-01-02');
  });
});
