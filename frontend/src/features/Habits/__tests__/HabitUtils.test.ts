/* eslint-env jest */
/* global describe, test, expect, jest */
import { validate as uuidValidate } from 'uuid';

import { brightenColor, STAGE_COLORS } from '../../../design/tokens';
import type { Habit, Goal } from '../Habits.types';
import {
  getProgressPercentage,
  getMarkerPositions,
  getGoalTier,
  calculateHabitProgress,
  calculateTodaysProgress,
  getProgressBarColor,
  isGoalAchieved,
  isHabitLockedToday,
  logHabitUnits,
  calculateHabitStartDate,
  STAGE_DURATIONS_DAYS,
} from '../HabitUtils';

describe('HabitUtils', () => {
  const baseHabit = {
    id: 1,
    name: 'Test',
    icon: '🔥',
    stage: 'Beige',
    streak: 0,
    energy_cost: 0,
    energy_return: 0,
    start_date: new Date(),
  } as const;

  test('getProgressPercentage additive clamps at 100', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 4,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 6,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ];
    const habit: Habit = {
      ...baseHabit,
      goals,
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 7 }],
    };
    const { currentGoal } = getGoalTier(habit);
    expect(getProgressPercentage(habit, currentGoal)).toBe(100);
  });

  test('getProgressPercentage subtractive returns proportion', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
    ];
    const habit: Habit = {
      ...baseHabit,
      goals,
      completions: [{ id: 'c-2', timestamp: new Date(), completed_units: 6 }],
    };
    const { currentGoal } = getGoalTier(habit);
    const pct = getProgressPercentage(habit, currentGoal);
    expect(Math.round(pct)).toBe(50);
  });

  // Pins the missing-stretch fallback: ``stretchGoal ?? currentGoal``.
  test('getProgressPercentage falls back to currentGoal when stretch is missing (additive)', () => {
    const lowOnly: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 4,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const habit: Habit = {
      ...baseHabit,
      goals: [lowOnly],
      completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 2 }],
    };
    // No stretch → fallback to ``lowOnly`` as the scale; 2 / 4 = 50%.
    expect(getProgressPercentage(habit, lowOnly)).toBeCloseTo(50);
  });

  // All three markers on the unified 0-100 bar (previous logic collapsed CG/SG to 100).
  test('getMarkerPositions additive places all three on a stretch-anchored scale', () => {
    const low: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 2,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const clear: Goal = {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 4,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const stretch: Goal = {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 6,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    const pos = getMarkerPositions(low, clear, stretch);
    // 2/6 ≈ 33.3, 4/6 ≈ 66.7, stretch always at 100.
    expect(pos.low).toBeCloseTo(33.33, 1);
    expect(pos.clear).toBeCloseTo(66.67, 1);
    expect(pos.stretch).toBe(100);
    // Strictly increasing — guards against a CG/SG-collapsed regression.
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });

  test('getMarkerPositions subtractive places all three on a low-anchored scale', () => {
    const low: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 10,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const clear: Goal = {
      id: 2,
      tier: 'clear',
      title: 'clear',
      target: 5,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const stretch: Goal = {
      id: 3,
      tier: 'stretch',
      title: 'stretch',
      target: 2,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: false,
    };
    const pos = getMarkerPositions(low, clear, stretch);
    // (10-5)/(10-2) × 100 = 62.5 — CG between LG (failure) and SG (best).
    expect(pos.low).toBe(0);
    expect(pos.clear).toBeCloseTo(62.5, 1);
    expect(pos.stretch).toBe(100);
    expect(pos.low).toBeLessThan(pos.clear);
    expect(pos.clear).toBeLessThan(pos.stretch);
  });

  test('getMarkerPositions returns zeros when any tier is missing', () => {
    const onlyLow: Goal = {
      id: 1,
      tier: 'low',
      title: 'low',
      target: 1,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    };
    expect(getMarkerPositions(onlyLow, undefined, undefined)).toEqual({
      low: 0,
      clear: 0,
      stretch: 0,
    });
  });

  test('logHabitUnits accumulates progress and increments streak once per day', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 15,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ];
    let habit: Habit = { ...baseHabit, goals, completions: [], streak: 0 };
    const day = new Date('2023-01-01T08:00:00');
    habit = logHabitUnits(habit, 3, day);
    expect(calculateHabitProgress(habit)).toBe(3);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 4, new Date('2023-01-01T12:00:00'));
    expect(calculateHabitProgress(habit)).toBe(7);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 2, new Date('2023-01-02T09:00:00'));
    expect(calculateHabitProgress(habit)).toBe(9);
    expect(habit.streak).toBe(2);
  });

  test('logHabitUnits supports subtractive habits', () => {
    const goals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
    ];
    let habit: Habit = { ...baseHabit, goals, completions: [], streak: 0 };
    habit = logHabitUnits(habit, 4, new Date('2023-01-01T08:00:00'));
    habit = logHabitUnits(habit, 3, new Date('2023-01-01T12:00:00'));
    expect(calculateHabitProgress(habit)).toBe(7);
    expect(habit.streak).toBe(1);
    habit = logHabitUnits(habit, 1, new Date('2023-01-02T09:00:00'));
    expect(habit.streak).toBe(2);
  });

  test('STAGE_DURATIONS_DAYS sums to 36 weeks (252 days)', () => {
    expect(STAGE_DURATIONS_DAYS).toHaveLength(10);
    const totalDays = STAGE_DURATIONS_DAYS.reduce((sum, d) => sum + d, 0);
    expect(totalDays).toBe(36 * 7);
  });

  test('calculateHabitStartDate offsets correctly', () => {
    const base = new Date('2024-01-01');
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 8; i++) {
      const result = calculateHabitStartDate(base, i);
      expect((result.getTime() - base.getTime()) / day).toBe(21 * i);
    }
    const ninth = calculateHabitStartDate(base, 8);
    expect((ninth.getTime() - base.getTime()) / day).toBe(168);
    const tenth = calculateHabitStartDate(base, 9);
    expect((tenth.getTime() - base.getTime()) / day).toBe(210);
  });

  test('logHabitUnits generates valid UUID string IDs for completions', () => {
    let habit: Habit = { ...baseHabit, goals: [], completions: [], streak: 0 };
    habit = logHabitUnits(habit, 1);
    const completion = habit.completions![0]!;
    expect(typeof completion.id).toBe('string');
    expect(uuidValidate(completion.id!)).toBe(true);
  });

  test('logHabitUnits generates unique IDs for each completion', () => {
    let habit: Habit = { ...baseHabit, goals: [], completions: [], streak: 0 };
    habit = logHabitUnits(habit, 1, new Date('2023-01-01'));
    habit = logHabitUnits(habit, 2, new Date('2023-01-02'));
    const ids = habit.completions!.map((c) => c.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(uuidValidate(ids[0]!)).toBe(true);
    expect(uuidValidate(ids[1]!)).toBe(true);
  });

  describe('daily reset of progress display', () => {
    const additiveGoals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 1,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 3,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ];

    const yesterdayUtc = (): Date => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      // Anchor at noon UTC so any reasonable user TZ still sees this as
      // "yesterday" rather than today's local hours.
      d.setUTCHours(12, 0, 0, 0);
      return d;
    };

    test('calculateTodaysProgress ignores completions logged on a previous day', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 5 }],
      };
      expect(calculateTodaysProgress(habit, 'UTC')).toBe(0);
      // The all-time accumulator still sees yesterday's log -- streaks /
      // stats rely on it. Pinned to keep the two helpers distinct.
      expect(calculateHabitProgress(habit)).toBe(5);
    });

    test('getGoalTier reports incomplete when only yesterday hit the stretch goal', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 5 }],
      };
      const { currentGoal, completedAllGoals } = getGoalTier(habit, 'UTC');
      expect(currentGoal.tier).toBe('low');
      expect(completedAllGoals).toBe(false);
    });

    test('getProgressPercentage resets to 0 on the new day for additive habits', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 5 }],
      };
      const { currentGoal } = getGoalTier(habit, 'UTC');
      expect(getProgressPercentage(habit, currentGoal, 'UTC')).toBe(0);
    });

    test('getProgressBarColor drops victory color the day after the goal was met', () => {
      const habit: Habit = {
        ...baseHabit,
        stage: 'Beige',
        goals: additiveGoals,
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 5 }],
      };
      expect(getProgressBarColor(habit, 'UTC')).toBe(STAGE_COLORS.Beige);
    });

    test('today-only progress combined with all-time history advances the tier on todays log', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [
          { id: 'y-1', timestamp: yesterdayUtc(), completed_units: 5 },
          { id: 't-1', timestamp: new Date(), completed_units: 1 },
        ],
      };
      // Today contributed 1 unit -- meets the low goal target (1) but not clear (2).
      expect(calculateTodaysProgress(habit, 'UTC')).toBe(1);
      const { currentGoal, completedAllGoals } = getGoalTier(habit, 'UTC');
      expect(currentGoal.tier).toBe('low');
      expect(completedAllGoals).toBe(false);
    });

    test("calculateTodaysProgress sums today's logs across multiple check-ins", () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [
          { id: 'y-1', timestamp: yesterdayUtc(), completed_units: 99 },
          { id: 't-1', timestamp: new Date(), completed_units: 1.5 },
          { id: 't-2', timestamp: new Date(), completed_units: 0.5 },
        ],
      };
      // Two of-today logs sum to 2.0; yesterday's 99 is excluded.
      expect(calculateTodaysProgress(habit, 'UTC')).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Subtractive habits ("drink less than X / day"): yesterday's drinks must
    // not count against today's "stayed under stretch" status either.
    // -----------------------------------------------------------------------
    const subtractiveGoals: Goal[] = [
      {
        id: 1,
        tier: 'low',
        title: 'low',
        target: 10,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 2,
        tier: 'clear',
        title: 'clear',
        target: 5,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
      {
        id: 3,
        tier: 'stretch',
        title: 'stretch',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: false,
      },
    ];

    test('subtractive habit re-enters victory state at local midnight', () => {
      const habit: Habit = {
        ...baseHabit,
        stage: 'Blue',
        goals: subtractiveGoals,
        // Yesterday the user blew past the low goal; today they have nothing
        // logged yet so they should be back at "under stretch" (full bar).
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 20 }],
      };
      const { currentGoal, completedAllGoals } = getGoalTier(habit, 'UTC');
      expect(currentGoal.tier).toBe('stretch');
      expect(completedAllGoals).toBe(true);
      expect(getProgressPercentage(habit, currentGoal, 'UTC')).toBe(100);
      expect(getProgressBarColor(habit, 'UTC')).toBe(brightenColor(STAGE_COLORS.Blue!));
    });

    test('subtractive habit drops out of victory once today crosses stretch', () => {
      const habit: Habit = {
        ...baseHabit,
        stage: 'Blue',
        goals: subtractiveGoals,
        completions: [
          { id: 'y-1', timestamp: yesterdayUtc(), completed_units: 20 },
          { id: 't-1', timestamp: new Date(), completed_units: 3 },
        ],
      };
      const { completedAllGoals } = getGoalTier(habit, 'UTC');
      // Today's 3 units are above stretch (2) but below clear (5) -> still
      // achieved-clear-not-stretch, so the "all goals" flag flips to false.
      expect(completedAllGoals).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Timezone handling: a completion logged 23:00 wall-clock in NY must be
    // bucketed into NY's calendar day, not UTC's.
    // -----------------------------------------------------------------------
    test('calculateTodaysProgress buckets by the supplied IANA timezone', () => {
      // Anchor "now" to 12:00 UTC so the relationship between the completion
      // (04:00 UTC same day) and the UTC/Anchorage "today" is deterministic
      // regardless of when CI runs. Without this anchor, runs in the early
      // UTC morning (before ~08:00 UTC) saw Anchorage's "today" coincide with
      // the completion's previous-day bucket and flipped the assertion.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));
      try {
        const earlyUtc = new Date('2026-05-15T04:00:00.000Z');
        const habit: Habit = {
          ...baseHabit,
          goals: additiveGoals,
          completions: [{ id: 'tz-1', timestamp: earlyUtc, completed_units: 2 }],
        };
        expect(calculateTodaysProgress(habit, 'UTC')).toBe(2);
        expect(calculateTodaysProgress(habit, 'America/Anchorage')).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    test('isGoalAchieved tracks today, not all-time', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [{ id: 'y-1', timestamp: yesterdayUtc(), completed_units: 99 }],
      };
      const stretchGoal = additiveGoals.find((g) => g.tier === 'stretch')!;
      expect(isGoalAchieved(stretchGoal, habit, 'UTC')).toBe(false);
    });

    test('habit with no completions reports zero today and no achievement', () => {
      const habit: Habit = {
        ...baseHabit,
        goals: additiveGoals,
        completions: [],
      };
      expect(calculateTodaysProgress(habit, 'UTC')).toBe(0);
      const { currentGoal, completedAllGoals } = getGoalTier(habit, 'UTC');
      expect(currentGoal.tier).toBe('low');
      expect(completedAllGoals).toBe(false);
    });
  });
});

describe('isHabitLockedToday', () => {
  const NOW = new Date('2026-04-06T12:00:00Z').getTime();
  const make = (overrides: Partial<Habit>): Habit =>
    ({
      id: 1,
      name: 'H',
      icon: '🔒',
      stage: 'Purple',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date('2026-04-06T00:00:00Z'),
      goals: [],
      completions: [],
      ...overrides,
    }) as Habit;

  test('locked when unrevealed and start_date is still in the future', () => {
    const habit = make({ revealed: false, start_date: new Date('2026-05-01T00:00:00Z') });
    expect(isHabitLockedToday(habit, NOW)).toBe(true);
  });

  test('unlocked once the calendar reaches its start_date, even if revealed is stale-false', () => {
    // The Purple habit: start_date has passed but the server flag was never
    // flipped. The calendar (start_date <= today) must win so the screen
    // tracks the same stage the Map/Practice show.
    const habit = make({ revealed: false, start_date: new Date('2026-04-01T00:00:00Z') });
    expect(isHabitLockedToday(habit, NOW)).toBe(false);
  });

  test('unlocked when manually revealed ahead of its start_date', () => {
    const habit = make({ revealed: true, start_date: new Date('2026-05-01T00:00:00Z') });
    expect(isHabitLockedToday(habit, NOW)).toBe(false);
  });

  test('unrevealed (undefined) future habit is treated as unlocked, matching prior contract', () => {
    const habit = make({ revealed: undefined, start_date: new Date('2026-05-01T00:00:00Z') });
    expect(isHabitLockedToday(habit, NOW)).toBe(false);
  });

  test('accepts ISO string start dates (server payloads arrive unparsed)', () => {
    // The API delivers ``start_date`` as an ISO string before it is mapped to
    // a Date, so the helper must tolerate both. Cast through ``unknown`` since
    // the Habit type declares the post-parse ``Date``.
    const iso = (value: string) => value as unknown as Date;
    expect(isHabitLockedToday(make({ revealed: false, start_date: iso('2999-01-01') }), NOW)).toBe(
      true,
    );
    expect(isHabitLockedToday(make({ revealed: false, start_date: iso('2000-01-01') }), NOW)).toBe(
      false,
    );
  });
});
