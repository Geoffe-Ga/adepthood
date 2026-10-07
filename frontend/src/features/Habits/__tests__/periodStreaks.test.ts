/* eslint-env jest */
/* global describe, it, expect, jest, afterEach */
import { dayKeyToInstant } from '../../../utils/dateUtils';
import type { Goal, Habit } from '../Habits.types';
import {
  formatStreakAdjective,
  formatStreakCount,
  generateStatsForHabit,
  logHabitUnits,
  periodCurrentStreak,
  periodLongestStreak,
  streakPeriodKind,
  type PeriodStreakCadence,
} from '../HabitUtils';

import { readBackendSource } from '@/testing/backendSource';

/**
 * Period-counted streaks for weekly / monthly cadences (#2819).
 *
 * The parity fixture is shared with the backend's
 * `tests/domain/test_period_streaks.py`; both sides must report the same
 * current / longest streak for every case.
 */

interface ParityCase {
  name: string;
  timezone: string;
  today: string;
  start_date: string;
  is_additive: boolean;
  frequency: number;
  frequency_unit: Goal['frequency_unit'];
  targets: Record<Goal['tier'], number>;
  completions: [string, number][];
  expected: { current: number; longest: number };
}

const { cases } = JSON.parse(
  readBackendSource('tests', 'fixtures', 'streak_parity', 'cadence_streaks.json'),
) as { cases: ParityCase[] };
const TIERS: Goal['tier'][] = ['low', 'clear', 'stretch'];

const habitFor = (c: ParityCase): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Lifting',
  icon: '🏋️',
  streak: 0,
  energy_cost: 0,
  energy_return: 0,
  start_date: dayKeyToInstant(c.start_date, c.timezone),
  goals: TIERS.map((tier, index) => ({
    id: index + 1,
    tier,
    title: tier,
    target: c.targets[tier],
    target_unit: 'sessions',
    frequency: c.frequency,
    frequency_unit: c.frequency_unit,
    is_additive: c.is_additive,
  })),
  completions: c.completions.map(([day, units], index) => ({
    id: `c-${index}`,
    timestamp: dayKeyToInstant(day, c.timezone),
    local_day: day,
    completed_units: units,
  })),
});

const freezeToday = (c: ParityCase): void => {
  jest.useFakeTimers();
  jest.setSystemTime(dayKeyToInstant(c.today, c.timezone));
};

afterEach(() => {
  jest.useRealTimers();
});

describe('shared client/server streak parity fixture', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    freezeToday(c);

    const stats = generateStatsForHabit(habitFor(c), c.timezone);

    expect(stats.currentStreak).toBe(c.expected.current);
    expect(stats.longestStreak).toBe(c.expected.longest);
  });
});

const weekly = (overrides: Partial<PeriodStreakCadence> = {}): PeriodStreakCadence => ({
  kind: 'week',
  periodTarget: 3,
  startDay: '2026-03-02',
  subtractive: false,
  ...overrides,
});

describe('period streak walk', () => {
  it('returns 0 before a subtractive habit has started', () => {
    const cadence = weekly({ subtractive: true, startDay: '2026-04-06' });
    expect(periodCurrentStreak([], '2026-03-11', cadence)).toBe(0);
    expect(periodLongestStreak([], '2026-03-11', cadence)).toBe(0);
  });

  it('counts additive history logged before the start date', () => {
    const days = [
      { day: '2026-02-23', units: 3 },
      { day: '2026-03-02', units: 3 },
    ];
    const cadence = weekly({ startDay: '2026-03-04' });
    expect(periodCurrentStreak(days, '2026-03-11', cadence)).toBe(2);
    expect(periodLongestStreak(days, '2026-03-11', cadence)).toBe(2);
  });

  it('resets the longest run on an unmet closed week', () => {
    const days = ['2026-02-02', '2026-02-09', '2026-02-16', '2026-03-02'].map((day) => ({
      day,
      units: 3,
    }));
    const cadence = weekly({ startDay: '2026-02-02' });
    expect(periodLongestStreak(days, '2026-03-11', cadence)).toBe(3);
    expect(periodCurrentStreak(days, '2026-03-11', cadence)).toBe(1);
  });

  it('walks months back across a year boundary', () => {
    const days = [
      { day: '2025-11-03', units: 4 },
      { day: '2025-12-31', units: 4 },
      { day: '2026-01-15', units: 4 },
    ];
    const cadence: PeriodStreakCadence = {
      kind: 'month',
      periodTarget: 4,
      startDay: '2025-11-01',
      subtractive: false,
    };
    expect(periodCurrentStreak(days, '2026-02-10', cadence)).toBe(3);
    expect(periodLongestStreak(days, '2026-02-10', cadence)).toBe(3);
  });
});

describe('streak copy', () => {
  it('keeps the daily copy and pluralises weeks and months', () => {
    expect(formatStreakCount(1, 'day')).toBe('1 days');
    expect(formatStreakCount(1, 'week')).toBe('1 week');
    expect(formatStreakCount(3, 'week')).toBe('3 weeks');
    expect(formatStreakCount(2, 'month')).toBe('2 months');
    expect(formatStreakAdjective(6, 'week')).toBe('6-week');
    expect(formatStreakAdjective(4, 'day')).toBe('4-day');
  });

  it('reads the streak period from the clear tier, falling back to day', () => {
    const [weeklyCase] = cases;
    expect(streakPeriodKind(habitFor(weeklyCase!))).toBe('week');
    expect(streakPeriodKind({ ...habitFor(weeklyCase!), goals: [] })).toBe('day');
  });
});

describe('optimistic weekly log', () => {
  it('extends the streak only when the log completes the open week', () => {
    const [weeklyCase] = cases;
    freezeToday(weeklyCase!);
    const habit = { ...habitFor(weeklyCase!), streak: 2 };
    const now = dayKeyToInstant(weeklyCase!.today, weeklyCase!.timezone);

    const second = logHabitUnits(habit, 1, now, weeklyCase!.timezone);
    expect(second.streak).toBe(2);

    const third = logHabitUnits(second, 1, now, weeklyCase!.timezone);
    expect(third.streak).toBe(3);
  });
});
