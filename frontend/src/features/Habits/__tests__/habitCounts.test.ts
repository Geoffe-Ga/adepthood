/* eslint-env jest */
import { jest, afterEach, describe, it, expect } from '@jest/globals';

import { countDoneToday, unlockedToday } from '../habitCounts';
import type { Habit } from '../Habits.types';

const DAY_MS = 24 * 60 * 60 * 1000;

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: 'leaf',
  streak: 0,
  energy_cost: 5,
  energy_return: 5,
  start_date: new Date('2020-01-01T00:00:00Z'),
  goals: [],
  completions: [],
  revealed: true,
  ...overrides,
});

describe('countDoneToday', () => {
  it('counts a habit with a completed_units > 0 completion timestamped today', () => {
    const habit = makeHabit({
      completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
    });
    expect(countDoneToday([habit])).toBe(1);
  });

  it('excludes a completion with completed_units === 0', () => {
    const habit = makeHabit({
      completions: [{ id: 'c1', timestamp: new Date(), completed_units: 0 }],
    });
    expect(countDoneToday([habit])).toBe(0);
  });

  it('excludes completions logged on a different calendar day', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
    const habit = makeHabit({
      completions: [{ id: 'c1', timestamp: twoDaysAgo, completed_units: 1 }],
    });
    expect(countDoneToday([habit])).toBe(0);
  });

  it('returns 0 for an empty habit list', () => {
    expect(countDoneToday([])).toBe(0);
  });

  it('buckets a near-midnight completion by the passed timezone, not UTC', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T02:00:00Z'));
    const habit = makeHabit({
      completions: [{ id: 'c1', timestamp: new Date('2026-07-01T20:00:00Z'), completed_units: 1 }],
    });
    // In UTC the completion (Jul 1) and now (Jul 2) fall on different days.
    expect(countDoneToday([habit], 'UTC')).toBe(0);
    // In Tokyo (UTC+9) both instants land on Jul 2, so it counts as done today.
    expect(countDoneToday([habit], 'Asia/Tokyo')).toBe(1);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('unlockedToday', () => {
  it('drops a habit that is unrevealed with a future start_date', () => {
    const locked = makeHabit({
      id: 2,
      revealed: false,
      start_date: new Date(Date.now() + 7 * DAY_MS),
    });
    expect(unlockedToday([locked])).toEqual([]);
  });

  it('keeps a revealed habit even with a future start_date', () => {
    const unlocked = makeHabit({
      id: 3,
      revealed: true,
      start_date: new Date(Date.now() + 7 * DAY_MS),
    });
    expect(unlockedToday([unlocked])).toEqual([unlocked]);
  });

  it('keeps an unrevealed habit whose start_date has already passed', () => {
    const unlocked = makeHabit({
      id: 4,
      revealed: false,
      start_date: new Date('2020-01-01T00:00:00Z'),
    });
    expect(unlockedToday([unlocked])).toEqual([unlocked]);
  });

  it('filters a mixed list down to only the unlocked habits', () => {
    const locked = makeHabit({
      id: 5,
      revealed: false,
      start_date: new Date(Date.now() + 7 * DAY_MS),
    });
    const unlocked = makeHabit({ id: 6, revealed: true });
    expect(unlockedToday([locked, unlocked])).toEqual([unlocked]);
  });
});
