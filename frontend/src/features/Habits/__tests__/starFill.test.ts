import { describe, expect, it, jest } from '@jest/globals';

import type { Goal, Habit } from '../Habits.types';
import { FULL_SWEEP_MS, MIN_SWEEP_MS, computeStarFillPlan, sweepDurationMs } from '../starFill';

const TZ = 'UTC';

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 42,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal('low'), makeGoal('clear'), makeGoal('stretch')],
  completions: [],
  revealed: true,
  ...overrides,
});

const withTodayUnits = (units: number, overrides: Partial<Habit> = {}): Habit =>
  makeHabit({
    completions: [{ id: 't-1', timestamp: new Date(), completed_units: units }],
    ...overrides,
  });

const subtractiveGoals = (): Goal[] => [
  makeGoal('low', { target: 25, is_additive: false }),
  makeGoal('clear', { target: 6, is_additive: false }),
  makeGoal('stretch', { target: 0, is_additive: false }),
];

describe('computeStarFillPlan — additive habits', () => {
  it('plans a full sweep to the stretch star from an empty bar', () => {
    const plan = computeStarFillPlan(makeHabit(), 'stretch', TZ);
    expect(plan).toEqual({
      habitId: 42,
      tier: 'stretch',
      fromPercent: 0,
      toPercent: 100,
      deltaUnits: 3,
      durationMs: FULL_SWEEP_MS,
    });
  });

  it('plans a proportional hop to the low star from an empty bar', () => {
    const plan = computeStarFillPlan(makeHabit(), 'low', TZ);
    expect(plan?.deltaUnits).toBe(1);
    expect(plan?.fromPercent).toBe(0);
    expect(plan?.toPercent).toBeCloseTo(33.33, 1);
    expect(plan?.durationMs).toBeCloseTo(FULL_SWEEP_MS / 3, 0);
  });

  it('logs only the remaining units when the bar starts mid-way', () => {
    const plan = computeStarFillPlan(withTodayUnits(2), 'stretch', TZ);
    expect(plan?.deltaUnits).toBe(1);
    expect(plan?.fromPercent).toBeCloseTo(66.67, 1);
    expect(plan?.toPercent).toBe(100);
  });

  it('plans a leftward (negative-delta) move when progress is past the pressed star', () => {
    const plan = computeStarFillPlan(withTodayUnits(2), 'low', TZ);
    expect(plan?.deltaUnits).toBe(-1);
    expect(plan?.fromPercent).toBeCloseTo(66.67, 1);
    expect(plan?.toPercent).toBeCloseTo(33.33, 1);
  });

  it('lands on the rescaled star when progress is twice the stretch target', () => {
    const plan = computeStarFillPlan(withTodayUnits(6), 'low', TZ);
    expect(plan?.deltaUnits).toBe(-5);
    expect(plan?.fromPercent).toBe(100);
    expect(plan?.toPercent).toBeCloseTo(16.67, 1);
  });

  it('returns null when today already sits exactly on the pressed star', () => {
    expect(computeStarFillPlan(withTodayUnits(2), 'clear', TZ)).toBeNull();
  });

  describe('weekly cadence: one hold logs one occurrence, never the whole week', () => {
    const weeklyGoals = (): Goal[] => [
      makeGoal('low', { target: 1, frequency: 3, frequency_unit: 'per_week' }),
      makeGoal('clear', { target: 2, frequency: 3, frequency_unit: 'per_week' }),
      makeGoal('stretch', { target: 3, frequency: 3, frequency_unit: 'per_week' }),
    ];

    it('logs the tier target once from an empty week, not target × frequency', () => {
      const habit = makeHabit({ goals: weeklyGoals() });
      const plan = computeStarFillPlan(habit, 'low', TZ);
      expect(plan?.deltaUnits).toBe(1);
      // Stretch period target is 9, so one logged unit lands at 1/9 of the bar
      // — short of the low star at 3/9 — rather than jumping onto the star.
      expect(plan?.fromPercent).toBe(0);
      expect(plan?.toPercent).toBeCloseTo(11.11, 1);
      // A one-ninth hop is shorter than the visibility floor, so it takes the floor.
      expect(plan?.durationMs).toBe(MIN_SWEEP_MS);
    });

    it('logs the clear target once toward the clear star', () => {
      const habit = makeHabit({ goals: weeklyGoals() });
      const plan = computeStarFillPlan(habit, 'clear', TZ);
      expect(plan?.deltaUnits).toBe(2);
      expect(plan?.toPercent).toBeCloseTo(22.22, 1);
    });

    it('logs only the remaining gap when one occurrence would overshoot the star', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-13T12:00:00Z')); // Friday
      try {
        const habit = makeHabit({
          goals: weeklyGoals(),
          completions: [
            {
              id: 'monday',
              timestamp: new Date('2000-01-01T00:00:00Z'),
              local_day: '2026-03-09',
              completed_units: 1,
            },
            {
              id: 'wednesday',
              timestamp: new Date('2000-01-01T00:00:00Z'),
              local_day: '2026-03-11',
              completed_units: 1.5,
            },
          ],
        });

        const plan = computeStarFillPlan(habit, 'low', TZ);
        expect(plan?.deltaUnits).toBe(0.5);
        expect(plan?.fromPercent).toBeCloseTo(27.78, 1);
        expect(plan?.toPercent).toBeCloseTo(33.33, 1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still walks all the way back to the star when the week is past it', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-13T12:00:00Z')); // Friday
      try {
        const habit = makeHabit({
          goals: weeklyGoals(),
          completions: [
            {
              id: 'monday',
              timestamp: new Date('2000-01-01T00:00:00Z'),
              local_day: '2026-03-09',
              completed_units: 6,
            },
          ],
        });

        const plan = computeStarFillPlan(habit, 'low', TZ);
        expect(plan?.deltaUnits).toBe(-3);
        expect(plan?.toPercent).toBeCloseTo(33.33, 1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('ignores completions from an earlier week', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-13T12:00:00Z')); // Friday
      try {
        const habit = makeHabit({
          goals: weeklyGoals(),
          completions: [
            {
              id: 'last-week',
              timestamp: new Date('2000-01-01T00:00:00Z'),
              local_day: '2026-03-06',
              completed_units: 2,
            },
          ],
        });
        expect(computeStarFillPlan(habit, 'low', TZ)?.deltaUnits).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('a monthly subtractive hold consumes one occurrence of the allowance, not the month', () => {
    const habit = makeHabit({
      goals: [
        makeGoal('low', {
          target: 4,
          frequency: 5,
          frequency_unit: 'per_month',
          is_additive: false,
        }),
        makeGoal('clear', {
          target: 2,
          frequency: 5,
          frequency_unit: 'per_month',
          is_additive: false,
        }),
        makeGoal('stretch', {
          target: 0,
          frequency: 5,
          frequency_unit: 'per_month',
          is_additive: false,
        }),
      ],
    });
    const plan = computeStarFillPlan(habit, 'low', TZ);
    expect(plan?.deltaUnits).toBe(4);
    // Period allowance is 20; consuming 4 of it drains the bar to 80%.
    expect(plan?.fromPercent).toBe(100);
    expect(plan?.toPercent).toBeCloseTo(80, 1);
  });
});

describe('computeStarFillPlan — subtractive habits', () => {
  it('plans a full drain to the low (loosest limit) star from a clean day', () => {
    const habit = makeHabit({ goals: subtractiveGoals() });
    const plan = computeStarFillPlan(habit, 'low', TZ);
    expect(plan).toEqual({
      habitId: 42,
      tier: 'low',
      fromPercent: 100,
      toPercent: 0,
      deltaUnits: 25,
      durationMs: FULL_SWEEP_MS,
    });
  });

  it('plans a partial drain to the clear star from a clean day', () => {
    const habit = makeHabit({ goals: subtractiveGoals() });
    const plan = computeStarFillPlan(habit, 'clear', TZ);
    expect(plan?.deltaUnits).toBe(6);
    expect(plan?.toPercent).toBeCloseTo(76, 1);
  });

  it('plans a rightward refill (negative delta) back to the stretch star after transgressions', () => {
    const habit = withTodayUnits(10, { goals: subtractiveGoals() });
    const plan = computeStarFillPlan(habit, 'stretch', TZ);
    expect(plan?.deltaUnits).toBe(-10);
    expect(plan?.fromPercent).toBeCloseTo(60, 1);
    expect(plan?.toPercent).toBe(100);
  });
});

describe('computeStarFillPlan — guards', () => {
  it('returns null when the habit has no id (synthetic onboarding state)', () => {
    const habit = makeHabit({ id: undefined as unknown as number });
    expect(computeStarFillPlan(habit, 'stretch', TZ)).toBeNull();
  });

  it('returns null when any tier goal is missing', () => {
    const habit = makeHabit({ goals: [makeGoal('low'), makeGoal('clear')] });
    expect(computeStarFillPlan(habit, 'low', TZ)).toBeNull();
  });
});

describe('sweepDurationMs', () => {
  it('scales linearly with the distance travelled', () => {
    expect(sweepDurationMs(0, 100)).toBe(FULL_SWEEP_MS);
    expect(sweepDurationMs(100, 0)).toBe(FULL_SWEEP_MS);
    expect(sweepDurationMs(25, 75)).toBe(FULL_SWEEP_MS / 2);
  });

  it('never drops below the visibility floor for short hops', () => {
    expect(sweepDurationMs(50, 51)).toBe(MIN_SWEEP_MS);
    expect(sweepDurationMs(50, 50)).toBe(MIN_SWEEP_MS);
  });
});
