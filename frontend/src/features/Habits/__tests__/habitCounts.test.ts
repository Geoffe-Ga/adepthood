/* eslint-env jest */
import { jest, afterEach, describe, it, expect } from '@jest/globals';

import { countDoneToday, unlockedHabits } from '../habitCounts';
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

describe('unlockedHabits', () => {
  it('returns only the revealed habit out of two', () => {
    const habit0 = makeHabit({ id: 10, revealed: true });
    const habit1 = makeHabit({ id: 11, revealed: false });
    expect(unlockedHabits([habit0, habit1])).toEqual([habit0]);
  });

  it('returns only the middle habit for an out-of-order revealed set', () => {
    const habit0 = makeHabit({ id: 20, revealed: false });
    const habit1 = makeHabit({ id: 21, revealed: true });
    const habit2 = makeHabit({ id: 22, revealed: false });
    expect(unlockedHabits([habit0, habit1, habit2])).toEqual([habit1]);
  });

  it('ignores stage and start_date entirely — only revealed matters', () => {
    const habits = [
      makeHabit({
        id: 30,
        stage: 'Clear Light',
        revealed: true,
        start_date: new Date(Date.now() + 7 * DAY_MS),
      }),
      makeHabit({
        id: 31,
        stage: 'Beige',
        revealed: false,
        start_date: new Date('2000-01-01T00:00:00Z'),
      }),
    ];
    expect(unlockedHabits(habits)).toEqual([habits[0]]);
  });

  it('returns an empty array when no habit is revealed', () => {
    const habits = [makeHabit({ id: 40, revealed: false }), makeHabit({ id: 41, revealed: false })];
    expect(unlockedHabits(habits)).toEqual([]);
  });

  it('returns an empty array for an empty habit list', () => {
    expect(unlockedHabits([])).toEqual([]);
  });
});
