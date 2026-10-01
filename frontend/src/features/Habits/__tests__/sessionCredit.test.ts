/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { Goal, Habit } from '../Habits.types';
import {
  MIN_MINUTE_CREDIT,
  SESSION_COUNT_CREDIT,
  SESSION_UNIT_GROUPS,
  isLinkableHabit,
  planSessionCredit,
} from '../sessionCredit';

const TZ = 'UTC';
const HABIT_ID = 42;
const LOW_TARGET = 10;
const CLEAR_TARGET = 20;
const STRETCH_TARGET = 30;
const TWENTY_MINUTES = 20;

const makeGoal = (tier: 'low' | 'clear' | 'stretch', overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 101 : tier === 'clear' ? 102 : 103,
  title: `${tier} goal`,
  tier,
  target: tier === 'low' ? LOW_TARGET : tier === 'clear' ? CLEAR_TARGET : STRETCH_TARGET,
  target_unit: 'min',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const ladder = (unit: string, extra: Partial<Goal> = {}): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier) =>
    makeGoal(tier, { target_unit: unit, ...extra }),
  );

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Journal',
  icon: '✍️',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: ladder('min'),
  completions: [],
  revealed: true,
  ...overrides,
});

const withUnit = (unit: string): Habit => makeHabit({ goals: ladder(unit) });

const withTodayUnits = (habit: Habit, units: number): Habit => ({
  ...habit,
  completions: [{ id: 't-1', timestamp: new Date(), completed_units: units }],
});

const credit = (habit: Habit, elapsedMinutes: number): number | null =>
  planSessionCredit(habit, { elapsedMinutes }, TZ);

describe('SESSION_UNIT_GROUPS — mirrors the backend unit groups by name', () => {
  it('names the minute and count groups the way detection_facts does', () => {
    expect(SESSION_UNIT_GROUPS.min).toEqual(['min', 'mins', 'minute', 'minutes']);
    expect(SESSION_UNIT_GROUPS.count).toEqual(['unit', 'units', 'time', 'times', 'x']);
    expect(SESSION_UNIT_GROUPS.rep).toEqual(['rep', 'reps']);
    expect(SESSION_UNIT_GROUPS.session).toEqual(['session', 'sessions']);
  });
});

describe('isLinkableHabit', () => {
  it('admits an additive, server-backed, unlocked habit with all three tiers', () => {
    expect(isLinkableHabit(makeHabit())).toBe(true);
  });

  it('refuses a subtractive habit: checking one off would record consumption', () => {
    expect(isLinkableHabit(makeHabit({ goals: ladder('min', { is_additive: false }) }))).toBe(
      false,
    );
  });

  it('refuses a locked habit', () => {
    expect(isLinkableHabit(makeHabit({ revealed: false }))).toBe(false);
    expect(isLinkableHabit(makeHabit({ revealed: undefined }))).toBe(false);
  });

  it('refuses a demo tile, a client-minted habit, and a placeholder id', () => {
    expect(isLinkableHabit(makeHabit({ isDemoSeed: true }))).toBe(false);
    expect(isLinkableHabit(makeHabit({ hasClientMintedIds: true }))).toBe(false);
    expect(isLinkableHabit(makeHabit({ id: -1 }))).toBe(false);
  });

  it('refuses a habit without the three-tier ladder', () => {
    expect(isLinkableHabit(makeHabit({ goals: [makeGoal('low'), makeGoal('clear')] }))).toBe(false);
  });
});

describe('planSessionCredit — minute habits are credited the minutes written', () => {
  it('credits a twenty-minute session with twenty, not the gap to the low tier', () => {
    expect(credit(withUnit('min'), TWENTY_MINUTES)).toBe(TWENTY_MINUTES);
  });

  it.each(SESSION_UNIT_GROUPS.min)('reads "%s" as minutes', (unit) => {
    expect(credit(withUnit(unit), TWENTY_MINUTES)).toBe(TWENTY_MINUTES);
  });

  it('reads the unit trimmed and case-insensitively', () => {
    expect(credit(withUnit('  Minutes '), TWENTY_MINUTES)).toBe(TWENTY_MINUTES);
  });

  it('keeps crediting past the low tier: minutes accumulate on the server', () => {
    const habit = withTodayUnits(withUnit('min'), STRETCH_TARGET);
    expect(credit(habit, TWENTY_MINUTES)).toBe(TWENTY_MINUTES);
  });

  it('credits nothing for a session shorter than a minute', () => {
    expect(credit(withUnit('min'), MIN_MINUTE_CREDIT - 1)).toBeNull();
    expect(credit(withUnit('min'), 0)).toBeNull();
  });

  it('credits the shortest session that counts as a minute', () => {
    expect(credit(withUnit('min'), MIN_MINUTE_CREDIT)).toBe(MIN_MINUTE_CREDIT);
  });

  it('credits nothing for an elapsed time that is not a number', () => {
    expect(credit(withUnit('min'), Number.NaN)).toBeNull();
  });
});

describe('planSessionCredit — count habits are credited one per session', () => {
  it.each([
    ...SESSION_UNIT_GROUPS.count,
    ...SESSION_UNIT_GROUPS.rep,
    ...SESSION_UNIT_GROUPS.session,
  ])('reads "%s" as one per session', (unit) => {
    expect(credit(withUnit(unit), TWENTY_MINUTES)).toBe(SESSION_COUNT_CREDIT);
  });

  it('a "3 times a day" habit goes 0 → 1 → 2 → 3 across sessions, and keeps counting', () => {
    const habit = withUnit('times');
    expect(credit(withTodayUnits(habit, 0), TWENTY_MINUTES)).toBe(SESSION_COUNT_CREDIT);
    expect(credit(withTodayUnits(habit, 2), TWENTY_MINUTES)).toBe(SESSION_COUNT_CREDIT);
    expect(credit(withTodayUnits(habit, LOW_TARGET), TWENTY_MINUTES)).toBe(SESSION_COUNT_CREDIT);
  });

  it('credits a session even when it rounded to zero minutes: the sitting still happened', () => {
    expect(credit(withUnit('sessions'), 0)).toBe(SESSION_COUNT_CREDIT);
  });
});

describe('planSessionCredit — any other unit keeps the gap-to-low rule', () => {
  it('credits exactly the gap to the low target', () => {
    expect(credit(withUnit('pages'), TWENTY_MINUTES)).toBe(LOW_TARGET);
  });

  it('credits only what is left when part of the low target is already logged', () => {
    expect(credit(withTodayUnits(withUnit('pages'), 4), TWENTY_MINUTES)).toBe(LOW_TARGET - 4);
  });

  it('credits nothing once the low target is met, or passed', () => {
    expect(credit(withTodayUnits(withUnit('oz'), LOW_TARGET), TWENTY_MINUTES)).toBeNull();
    expect(credit(withTodayUnits(withUnit('hours'), LOW_TARGET + 1), TWENTY_MINUTES)).toBeNull();
  });

  it('ignores the elapsed time entirely', () => {
    expect(credit(withUnit('pages'), 0)).toBe(LOW_TARGET);
  });
});

describe('planSessionCredit — gating', () => {
  it('credits nothing for a habit that cannot be linked', () => {
    expect(credit(makeHabit({ isDemoSeed: true }), TWENTY_MINUTES)).toBeNull();
    expect(credit(makeHabit({ revealed: false }), TWENTY_MINUTES)).toBeNull();
  });
});
