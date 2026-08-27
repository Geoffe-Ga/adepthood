import { describe, expect, it } from '@jest/globals';

import type { Goal, Habit } from '../../Habits.types';
import {
  isNotDemoSeed,
  isServerBackedGoal,
  isServerBackedHabit,
  isServerIssuedId,
} from '../serverIds';

const makeGoal = (overrides: Partial<Goal> = {}): Goal => ({
  id: 1,
  title: 'Low',
  tier: 'low',
  target: 1,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '\u{1F9D8}',
  streak: 0,
  energy_cost: 1,
  energy_return: 2,
  start_date: new Date('2025-01-01'),
  goals: [makeGoal()],
  completions: [],
  revealed: true,
  ...overrides,
});

// A frozen stand-in for ``-Date.now()`` so the table never drifts with the clock.
const SYNTHETIC_ID = -1_756_000_000_000;

type IdCase = [string, number | null | undefined, boolean];

const idCases: IdCase[] = [
  ['the lowest id a server can issue', 1, true],
  ['an id well outside the demo seed range', 42, true],
  ['zero', 0, false],
  ['a small negative id', -1, false],
  ['a negative timestamp placeholder', SYNTHETIC_ID, false],
  ['a fractional id', 1.5, false],
  ['NaN', Number.NaN, false],
  ['Infinity', Number.POSITIVE_INFINITY, false],
  ['undefined', undefined, false],
  ['null', null, false],
];

describe('isServerIssuedId', () => {
  it.each(idCases)('%s', (_label, id, expected) => {
    expect(isServerIssuedId(id)).toBe(expected);
  });
});

describe('isNotDemoSeed', () => {
  it('accepts a row with no demo marker', () => {
    expect(isNotDemoSeed({})).toBe(true);
  });

  it('accepts a row whose marker is explicitly false', () => {
    expect(isNotDemoSeed({ isDemoSeed: false })).toBe(true);
  });

  it('rejects a marked demo row', () => {
    expect(isNotDemoSeed({ isDemoSeed: true })).toBe(false);
  });
});

describe('isServerBackedHabit', () => {
  it('accepts a habit the server issued an id for', () => {
    expect(isServerBackedHabit(makeHabit({ id: 42 }))).toBe(true);
  });

  it('rejects a demo tile even though its id is a positive integer', () => {
    expect(isServerBackedHabit(makeHabit({ id: 3, isDemoSeed: true }))).toBe(false);
  });

  it('rejects a negative synthetic id', () => {
    expect(isServerBackedHabit(makeHabit({ id: -1 }))).toBe(false);
  });

  it('rejects the timestamp placeholder a freshly added habit carries', () => {
    expect(isServerBackedHabit(makeHabit({ id: SYNTHETIC_ID }))).toBe(false);
  });

  it('rejects id zero', () => {
    expect(isServerBackedHabit(makeHabit({ id: 0 }))).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isServerBackedHabit(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isServerBackedHabit(null)).toBe(false);
  });
});

describe('isServerBackedGoal', () => {
  it('accepts a positive goal id under a server-backed parent', () => {
    expect(isServerBackedGoal(makeGoal({ id: 7 }), makeHabit({ id: 42 }))).toBe(true);
  });

  it('rejects a positive goal id under a demo parent', () => {
    // A Goal carries no demo marker, so a goal-only check cannot see this case.
    expect(isServerBackedGoal(makeGoal({ id: 7 }), makeHabit({ id: 3, isDemoSeed: true }))).toBe(
      false,
    );
  });

  it('rejects a positive goal id under a negative-id parent', () => {
    expect(isServerBackedGoal(makeGoal({ id: 7 }), makeHabit({ id: SYNTHETIC_ID }))).toBe(false);
  });

  it('rejects a goal with no id under a server-backed parent', () => {
    expect(isServerBackedGoal(makeGoal({ id: undefined }), makeHabit({ id: 42 }))).toBe(false);
  });

  it('rejects a negative goal id under a server-backed parent', () => {
    expect(isServerBackedGoal(makeGoal({ id: SYNTHETIC_ID - 1 }), makeHabit({ id: 42 }))).toBe(
      false,
    );
  });

  it('rejects any goal when the parent is missing', () => {
    expect(isServerBackedGoal(makeGoal({ id: 7 }), undefined)).toBe(false);
  });
});
