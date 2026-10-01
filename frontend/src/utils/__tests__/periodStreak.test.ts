import { describe, expect, it } from '@jest/globals';

import {
  longestPeriodStreak,
  periodProgress,
  periodStartKey,
  periodStreakFromCompletions,
  type PeriodCadence,
} from '../dateUtils';

/** Wednesday 2026-06-17, 18:00 UTC (11:00 in Los Angeles). */
const NOW = new Date('2026-06-17T18:00:00Z');
const WEEKLY: PeriodCadence = { unit: 'week', daysNeeded: 4, dayTarget: 3 };
const MONTHLY: PeriodCadence = { unit: 'month', daysNeeded: 2, dayTarget: 1 };

const log = (day: string, units: number) => ({ timestamp: day, completed_units: units });

/** `units` on each of `days`. */
const logs = (days: string[], units: number) => days.map((day) => log(day, units));

/** Four done days in the ISO week starting on Monday `monday`. */
const fullWeek = (monday: string) => {
  const [year, month, day] = monday.split('-').map((part) => Number.parseInt(part, 10));
  return [0, 1, 2, 3].map((offset) =>
    log(new Date(Date.UTC(year!, month! - 1, day! + offset)).toISOString().slice(0, 10), 3),
  );
};

describe('periodStartKey', () => {
  it('starts a week on Monday', () => {
    expect(periodStartKey('2026-06-15', 'week')).toBe('2026-06-15'); // Monday
    expect(periodStartKey('2026-06-17', 'week')).toBe('2026-06-15'); // Wednesday
    expect(periodStartKey('2026-06-21', 'week')).toBe('2026-06-15'); // Sunday
    expect(periodStartKey('2026-06-22', 'week')).toBe('2026-06-22'); // next Monday
  });

  it('crosses month and year boundaries when finding Monday', () => {
    expect(periodStartKey('2026-01-01', 'week')).toBe('2025-12-29');
  });

  it('starts a month on its first day', () => {
    expect(periodStartKey('2026-06-17', 'month')).toBe('2026-06-01');
    expect(periodStartKey('2026-06-01', 'month')).toBe('2026-06-01');
  });
});

describe('periodStreakFromCompletions (weekly)', () => {
  it('returns 0 with no completions', () => {
    expect(periodStreakFromCompletions([], WEEKLY, 'UTC', NOW)).toBe(0);
  });

  it('counts the current week when it is already complete', () => {
    const completions = logs(['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18'], 3);
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(1);
  });

  it('skips an in-progress current week without breaking the chain', () => {
    const completions = [
      ...fullWeek('2026-06-01'),
      ...fullWeek('2026-06-08'),
      ...logs(['2026-06-15', '2026-06-16'], 3),
    ];
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(2);
  });

  it('adds the current week once it completes', () => {
    const completions = [
      ...fullWeek('2026-06-01'),
      ...fullWeek('2026-06-08'),
      ...fullWeek('2026-06-15'),
    ];
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(3);
  });

  it('stops at the first incomplete earlier week', () => {
    const completions = [
      ...fullWeek('2026-05-25'),
      ...fullWeek('2026-06-01'),
      ...logs(['2026-06-08', '2026-06-09', '2026-06-10'], 3), // 3 of 4 days
      ...logs(['2026-06-15'], 3),
    ];
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(0);
  });

  it('stops at a calendar gap even when older weeks were complete', () => {
    const completions = [...fullWeek('2026-05-25'), ...fullWeek('2026-06-08')];
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(1);
  });

  it('only counts a day once its summed units reach the per-day target', () => {
    // Four days with 2 units each: logged, but none reach the target of 3.
    const under = logs(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'], 2);
    expect(periodStreakFromCompletions(under, WEEKLY, 'UTC', NOW)).toBe(0);
    // Two rows on the same day sum across tiers to reach it.
    const summed = [
      ...logs(['2026-06-08', '2026-06-09', '2026-06-10'], 3),
      log('2026-06-11', 1),
      log('2026-06-11', 2),
    ];
    expect(periodStreakFromCompletions(summed, WEEKLY, 'UTC', NOW)).toBe(1);
  });

  it('never treats a zero-unit day as done, even against a zero target', () => {
    const cadence: PeriodCadence = { unit: 'week', daysNeeded: 1, dayTarget: 0 };
    expect(periodStreakFromCompletions([log('2026-06-08', 0)], cadence, 'UTC', NOW)).toBe(0);
    expect(periodStreakFromCompletions([log('2026-06-08', 1)], cadence, 'UTC', NOW)).toBe(1);
  });

  it('buckets instants into the user zone before choosing the week', () => {
    // 03:00 UTC Monday 2026-06-15 is still Sunday 2026-06-14 in Los Angeles,
    // so it belongs to the previous week there and completes it.
    const completions = [
      ...logs(['2026-06-08', '2026-06-09', '2026-06-10'], 3),
      log('2026-06-15T03:00:00Z', 3),
    ];
    expect(periodStreakFromCompletions(completions, WEEKLY, 'America/Los_Angeles', NOW)).toBe(1);
    expect(periodStreakFromCompletions(completions, WEEKLY, 'UTC', NOW)).toBe(0);
  });

  it('terminates for a malformed zero-days cadence', () => {
    const cadence: PeriodCadence = { unit: 'week', daysNeeded: 0, dayTarget: 1 };
    expect(periodStreakFromCompletions([log('2026-06-16', 1)], cadence, 'UTC', NOW)).toBe(1);
  });
});

describe('periodStreakFromCompletions (monthly)', () => {
  it('walks calendar months, skipping an in-progress current month', () => {
    const completions = [
      ...logs(['2026-04-03', '2026-04-20'], 1),
      ...logs(['2026-05-01', '2026-05-31'], 1),
      log('2026-06-02', 1),
    ];
    expect(periodStreakFromCompletions(completions, MONTHLY, 'UTC', NOW)).toBe(2);
  });

  it('crosses a year boundary between adjacent months', () => {
    const now = new Date('2026-01-20T12:00:00Z');
    const completions = [
      ...logs(['2025-11-03', '2025-11-20'], 1),
      ...logs(['2025-12-01', '2025-12-31'], 1),
      ...logs(['2026-01-02', '2026-01-03'], 1),
    ];
    expect(periodStreakFromCompletions(completions, MONTHLY, 'UTC', now)).toBe(3);
  });

  it('breaks on a month with too few done days', () => {
    const completions = [
      ...logs(['2026-04-03', '2026-04-20'], 1),
      log('2026-05-01', 1),
      ...logs(['2026-06-02', '2026-06-03'], 1),
    ];
    expect(periodStreakFromCompletions(completions, MONTHLY, 'UTC', NOW)).toBe(1);
  });
});

describe('periodProgress', () => {
  it('counts done days in the current week against the days needed', () => {
    const completions = [...fullWeek('2026-06-08'), ...logs(['2026-06-15', '2026-06-16'], 3)];
    expect(periodProgress(completions, WEEKLY, 'UTC', NOW)).toEqual({ doneDays: 2, daysNeeded: 4 });
  });

  it('reports zero done days for an empty current period', () => {
    expect(periodProgress([], MONTHLY, 'UTC', NOW)).toEqual({ doneDays: 0, daysNeeded: 2 });
    expect(periodProgress(fullWeek('2026-06-08'), WEEKLY, 'UTC', NOW)).toEqual({
      doneDays: 0,
      daysNeeded: 4,
    });
  });

  it('does not count a day under the per-day target', () => {
    const completions = [log('2026-06-15', 2), log('2026-06-16', 3)];
    expect(periodProgress(completions, WEEKLY, 'UTC', NOW)).toEqual({ doneDays: 1, daysNeeded: 4 });
  });
});

describe('longestPeriodStreak', () => {
  it('is 0 with nothing complete', () => {
    expect(longestPeriodStreak([], WEEKLY, 'UTC')).toBe(0);
    expect(longestPeriodStreak(logs(['2026-06-08'], 3), WEEKLY, 'UTC')).toBe(0);
  });

  it('finds the longest run of calendar-adjacent complete weeks', () => {
    const completions = [
      ...fullWeek('2026-04-06'),
      ...fullWeek('2026-04-13'),
      ...fullWeek('2026-04-20'),
      // gap: week of 04-27
      ...fullWeek('2026-05-04'),
      ...fullWeek('2026-05-11'),
    ];
    expect(longestPeriodStreak(completions, WEEKLY, 'UTC')).toBe(3);
  });

  it('finds adjacent complete months across a year boundary', () => {
    const completions = [
      ...logs(['2025-12-01', '2025-12-02'], 1),
      ...logs(['2026-01-01', '2026-01-02'], 1),
      ...logs(['2026-03-01', '2026-03-02'], 1),
    ];
    expect(longestPeriodStreak(completions, MONTHLY, 'UTC')).toBe(2);
  });
});
