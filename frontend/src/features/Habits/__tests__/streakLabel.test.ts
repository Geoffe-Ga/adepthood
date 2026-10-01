import { describe, expect, it } from '@jest/globals';

import type { Habit } from '../Habits.types';
import { formatStreakLabel, streakPeriodFor } from '../streakLabel';

describe('formatStreakLabel', () => {
  it('keeps the daily label byte-for-byte', () => {
    expect(formatStreakLabel(3, false)).toBe('3 DAYS');
    expect(formatStreakLabel(3, true)).toBe('3 DAYS — ACHIEVED TODAY!');
    expect(formatStreakLabel(0, false)).toBe('0 DAYS');
  });

  it('renders a weekly streak with the current week progress', () => {
    expect(formatStreakLabel(1, false, { unit: 'week', doneDays: 2, daysNeeded: 4 })).toBe(
      '1 WEEK · 2/4 DAYS',
    );
    expect(formatStreakLabel(2, false, { unit: 'week', doneDays: 2, daysNeeded: 4 })).toBe(
      '2 WEEKS · 2/4 DAYS',
    );
  });

  it('renders a monthly streak, singular for one', () => {
    expect(formatStreakLabel(1, false, { unit: 'month', doneDays: 2, daysNeeded: 4 })).toBe(
      '1 MONTH · 2/4 DAYS',
    );
    expect(formatStreakLabel(3, false, { unit: 'month', doneDays: 0, daysNeeded: 4 })).toBe(
      '3 MONTHS · 0/4 DAYS',
    );
  });

  it('appends the achieved suffix to a period label', () => {
    expect(formatStreakLabel(2, true, { unit: 'week', doneDays: 3, daysNeeded: 4 })).toBe(
      '2 WEEKS · 3/4 DAYS — ACHIEVED TODAY!',
    );
  });
});

describe('streakPeriodFor', () => {
  const NOW = new Date('2026-06-17T18:00:00Z'); // Wednesday
  const goal = (tier: Habit['goals'][number]['tier'], overrides = {}) => ({
    id: 1,
    title: tier,
    tier,
    target: 1,
    target_unit: 'reps',
    frequency: 4,
    frequency_unit: 'per_week',
    is_additive: true,
    ...overrides,
  });
  const base: Habit = {
    id: 7,
    stage: 'Beige',
    name: 'Sit',
    icon: '🧘',
    streak: 2,
    energy_cost: 1,
    energy_return: 2,
    start_date: new Date('2026-01-01T00:00:00Z'),
    goals: [goal('low'), goal('clear', { target: 2 }), goal('stretch', { target: 3 })],
    completions: [
      { id: 'a', timestamp: new Date('2026-06-15T10:00:00Z'), completed_units: 1 },
      { id: 'b', timestamp: new Date('2026-06-16T10:00:00Z'), completed_units: 1 },
    ],
  };

  it('is undefined for a daily habit', () => {
    const daily = { ...base, goals: base.goals.map((g) => ({ ...g, frequency_unit: 'per_day' })) };
    expect(streakPeriodFor(daily, 'UTC', NOW)).toBeUndefined();
  });

  it('is undefined for a subtractive habit, whose streak stays in days', () => {
    const subtractive = { ...base, goals: base.goals.map((g) => ({ ...g, is_additive: false })) };
    expect(streakPeriodFor(subtractive, 'UTC', NOW)).toBeUndefined();
  });

  it('reads the current period progress for a weekly habit', () => {
    expect(streakPeriodFor(base, 'UTC', NOW)).toEqual({ unit: 'week', doneDays: 2, daysNeeded: 4 });
  });

  it('prefers local_day over the timestamp when bucketing', () => {
    const habit: Habit = {
      ...base,
      completions: [
        // Timestamp says Monday, local_day says last Sunday: the row counts there.
        {
          id: 'a',
          timestamp: new Date('2026-06-15T03:00:00Z'),
          local_day: '2026-06-14',
          completed_units: 1,
        },
      ],
    };
    expect(streakPeriodFor(habit, 'UTC', NOW)).toEqual({
      unit: 'week',
      doneDays: 0,
      daysNeeded: 4,
    });
  });
});
