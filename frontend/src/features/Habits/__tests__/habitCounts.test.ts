/* eslint-env jest */
import { jest, afterEach, describe, it, expect } from '@jest/globals';

import { countDoneToday, unlockedAtStage } from '../habitCounts';
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

describe('unlockedAtStage', () => {
  it('returns only the first-stage habit at stage 1', () => {
    const habit0 = makeHabit({ id: 10, stage: 'Beige' });
    const habit1 = makeHabit({ id: 11, stage: 'Purple' });
    expect(unlockedAtStage([habit0, habit1], 1)).toEqual([habit0]);
  });

  it('returns the first three stages at stage 3 regardless of revealed/start_date', () => {
    const habits = [
      makeHabit({
        id: 20,
        stage: 'Beige',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
      makeHabit({
        id: 21,
        stage: 'Purple',
        revealed: false,
        start_date: new Date(Date.now() + 7 * DAY_MS),
      }),
      makeHabit({ id: 22, stage: 'Red' }),
    ];
    expect(unlockedAtStage(habits, 3)).toEqual(habits);
  });

  it('excludes a habit whose stage is above currentStage even with a past start_date', () => {
    const habits = [
      makeHabit({ id: 30, stage: 'Beige' }),
      makeHabit({ id: 31, stage: 'Purple' }),
      makeHabit({ id: 32, stage: 'Red' }),
      makeHabit({ id: 33, stage: 'Blue' }),
      makeHabit({ id: 34, stage: 'Orange' }),
      makeHabit({
        id: 35,
        stage: 'Green',
        revealed: false,
        start_date: new Date('2020-01-01T00:00:00Z'),
      }),
    ];
    const result = unlockedAtStage(habits, 3);
    expect(result).toEqual(habits.slice(0, 3));
    expect(result).not.toContain(habits[5]);
  });

  it('includes an early-unlocked habit whose stage is at or above currentStage', () => {
    const habits = [
      makeHabit({ id: 40, stage: 'Beige' }),
      makeHabit({
        id: 41,
        stage: 'Purple',
        revealed: true,
        start_date: new Date(Date.now() + 7 * DAY_MS),
      }),
    ];
    expect(unlockedAtStage(habits, 1)).toEqual(habits);
  });

  it('returns an empty array for an empty habit list', () => {
    expect(unlockedAtStage([], 3)).toEqual([]);
  });
});
