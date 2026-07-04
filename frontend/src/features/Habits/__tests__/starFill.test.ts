import { describe, expect, it } from '@jest/globals';

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

  it('returns null when today already sits exactly on the pressed star', () => {
    expect(computeStarFillPlan(withTodayUnits(2), 'clear', TZ)).toBeNull();
  });

  it('normalizes per-week targets to their daily equivalent', () => {
    const habit = makeHabit({
      goals: [
        makeGoal('low', { target: 7, frequency_unit: 'per_week' }),
        makeGoal('clear', { target: 14, frequency_unit: 'per_week' }),
        makeGoal('stretch', { target: 21, frequency_unit: 'per_week' }),
      ],
    });
    const plan = computeStarFillPlan(habit, 'low', TZ);
    expect(plan?.deltaUnits).toBeCloseTo(1, 5);
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
