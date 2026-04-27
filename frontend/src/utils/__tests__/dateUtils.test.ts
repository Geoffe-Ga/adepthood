import { describe, it, expect } from '@jest/globals';

import {
  DEFAULT_TIMEZONE,
  addDaysInTZ,
  dayKeyInTZ,
  dayLabel,
  detectDeviceTimezone,
  streakFromCompletions,
  todayInUserTZ,
} from '../dateUtils';

describe('todayInUserTZ', () => {
  it('returns YYYY-MM-DD form', () => {
    const today = todayInUserTZ('UTC');
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to UTC for unknown zone', () => {
    const fallback = todayInUserTZ('Mars/Olympus_Mons');
    const utc = todayInUserTZ('UTC');
    expect(fallback).toBe(utc);
  });

  it('handles null / undefined / empty', () => {
    const utc = todayInUserTZ('UTC');
    // @ts-expect-error: intentional bad input
    expect(todayInUserTZ(null)).toBe(utc);
    // @ts-expect-error: intentional bad input
    expect(todayInUserTZ(undefined)).toBe(utc);
    expect(todayInUserTZ('')).toBe(utc);
  });
});

describe('dayKeyInTZ', () => {
  it('converts UTC midnight to prior day in Pacific (BUG-FE-HABIT-207)', () => {
    // 06:30 UTC = 23:30 PDT prior day.
    const moment = new Date('2026-06-15T06:30:00Z');
    expect(dayKeyInTZ(moment, 'America/Los_Angeles')).toBe('2026-06-14');
    expect(dayKeyInTZ(moment, 'UTC')).toBe('2026-06-15');
  });

  it('passes through YYYY-MM-DD strings unchanged', () => {
    expect(dayKeyInTZ('2026-06-15', 'America/Los_Angeles')).toBe('2026-06-15');
  });

  it('parses ISO-8601 strings', () => {
    expect(dayKeyInTZ('2026-06-15T06:30:00Z', 'America/Los_Angeles')).toBe('2026-06-14');
  });

  it('handles Pacific/Pago_Pago lag (UTC-11)', () => {
    const moment = new Date('2026-06-15T05:00:00Z');
    expect(dayKeyInTZ(moment, 'Pacific/Pago_Pago')).toBe('2026-06-14');
  });

  it('handles Pacific/Kiritimati lead (UTC+14)', () => {
    const moment = new Date('2026-06-14T18:00:00Z');
    expect(dayKeyInTZ(moment, 'Pacific/Kiritimati')).toBe('2026-06-15');
  });
});

describe('dayLabel', () => {
  it('returns three-letter English weekday', () => {
    // 2026-06-15 is a Monday in any common timezone.
    expect(dayLabel('2026-06-15', 'UTC')).toBe('Mon');
  });

  it('matches the user-local label, not UTC', () => {
    // 2026-06-14T23:00Z was Sunday in UTC, still Sunday in LA.
    // We pin a known mapping and assert the helper agrees.
    expect(dayLabel('2026-06-14', 'America/Los_Angeles')).toBe('Sun');
  });
});

describe('addDaysInTZ', () => {
  it('adds positive day count', () => {
    expect(addDaysInTZ('2026-06-15', 1, 'UTC')).toBe('2026-06-16');
  });

  it('subtracts via negative count', () => {
    expect(addDaysInTZ('2026-06-15', -1, 'UTC')).toBe('2026-06-14');
  });

  it('crosses month boundary', () => {
    expect(addDaysInTZ('2026-06-30', 1, 'UTC')).toBe('2026-07-01');
  });

  it('crosses year boundary', () => {
    expect(addDaysInTZ('2026-12-31', 1, 'UTC')).toBe('2027-01-01');
    expect(addDaysInTZ('2026-01-01', -1, 'UTC')).toBe('2025-12-31');
  });

  it('does not skip leap day in 2024', () => {
    expect(addDaysInTZ('2024-02-28', 1, 'UTC')).toBe('2024-02-29');
    expect(addDaysInTZ('2024-02-29', 1, 'UTC')).toBe('2024-03-01');
  });
});

describe('streakFromCompletions', () => {
  // Lock "today" so the assertions don't drift across CI runs.
  const TODAY_PACIFIC_MORNING = new Date('2026-06-15T18:00:00Z'); // 11 AM PDT 2026-06-15

  it('returns 0 for no completions', () => {
    expect(streakFromCompletions([], 'UTC', TODAY_PACIFIC_MORNING)).toBe(0);
  });

  it('counts a single today-completion as 1', () => {
    const completed = ['2026-06-15T17:00:00Z']; // 10 AM PDT today
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(1);
  });

  it('counts three consecutive days as 3', () => {
    const completed = ['2026-06-13T17:00:00Z', '2026-06-14T17:00:00Z', '2026-06-15T17:00:00Z'];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(3);
  });

  it('counts yesterday as 1 even if today is missing (grace period)', () => {
    // The user has not completed *today* yet; a streak of yesterday-only
    // is still considered active so the UI does not flash "streak lost"
    // before the user has had their full day to complete.
    const completed = ['2026-06-14T17:00:00Z'];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(1);
  });

  it('returns 0 when last completion is older than yesterday (BUG-FE-HABIT-207)', () => {
    // Completion was 3 days ago; the streak should be broken regardless
    // of how many days were chained before then.
    const completed = ['2026-06-10T17:00:00Z', '2026-06-11T17:00:00Z', '2026-06-12T17:00:00Z'];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(0);
  });

  it('stops at the first gap in the chain', () => {
    const completed = [
      '2026-06-10T17:00:00Z', // gap follows
      '2026-06-13T17:00:00Z',
      '2026-06-14T17:00:00Z',
      '2026-06-15T17:00:00Z',
    ];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(3);
  });

  it('collapses multiple completions on the same day', () => {
    const completed = [
      '2026-06-15T13:00:00Z', // morning Pacific
      '2026-06-15T22:00:00Z', // evening Pacific
    ];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(1);
  });

  it('uses user TZ to bucket — same UTC day, two Pacific days', () => {
    // 06:30 UTC 2026-06-15 = 23:30 PDT 2026-06-14
    // 18:00 UTC 2026-06-15 = 11:00 PDT 2026-06-15
    const completed = ['2026-06-15T06:30:00Z', '2026-06-15T18:00:00Z'];
    expect(streakFromCompletions(completed, 'America/Los_Angeles', TODAY_PACIFIC_MORNING)).toBe(2);
    // UTC sees both timestamps on the same day -> streak 1.
    expect(streakFromCompletions(completed, 'UTC', TODAY_PACIFIC_MORNING)).toBe(1);
  });
});

describe('detectDeviceTimezone', () => {
  it('returns a non-empty string', () => {
    const tz = detectDeviceTimezone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_TIMEZONE', () => {
  it('is UTC', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC');
  });
});
