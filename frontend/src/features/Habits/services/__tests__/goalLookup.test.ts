/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { findServerBackedGoalUnit } from '../goalLookup';

import type { Goal, Habit } from '@/features/Habits/Habits.types';

/**
 * The offer card names the unit the accept will log in, and it reads that unit
 * out of the habit store by `goal_id`. Onboarding mints goal ids `1..3n` —
 * byte-identical to the ids the server issues — and demo tiles fabricate theirs
 * outright, so a bare id scan can return another row's unit and make the card
 * ask the writer to consent to "64 glasses" when the server will log ounces.
 * Every row below carries goal id 42.
 */
const goal = (unit: string): Goal => ({
  id: 42,
  title: 'Water',
  tier: 'clear',
  target: 64,
  target_unit: unit,
  frequency: 1,
  frequency_unit: 'day',
  is_additive: true,
});

const habit = (overrides: Partial<Habit> & { goals: Goal[] }): Habit => ({
  id: 9,
  stage: 'Beige',
  name: 'Drink water',
  icon: '💧',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const serverRow = habit({ id: 9, goals: [goal('oz')] });
const demoRow = habit({ id: 3, isDemoSeed: true, goals: [goal('glasses')] });
const clientMintedRow = habit({ id: 4, hasClientMintedIds: true, goals: [goal('cups')] });
// A row cached by a build predating the marker: no `hasClientMintedIds`, but a
// negative placeholder id, which is the half a provenance-only check drops.
const placeholderRow = habit({ id: -1, goals: [goal('pages')] });

describe('findServerBackedGoalUnit', () => {
  it('returns the server row unit whatever order the imposters appear in', () => {
    expect(
      findServerBackedGoalUnit([demoRow, clientMintedRow, placeholderRow, serverRow], 42),
    ).toBe('oz');
    expect(
      findServerBackedGoalUnit([serverRow, demoRow, clientMintedRow, placeholderRow], 42),
    ).toBe('oz');
  });

  it('returns null for a demo-seed goal', () => {
    expect(findServerBackedGoalUnit([demoRow], 42)).toBeNull();
  });

  it('returns null for a client-minted goal', () => {
    expect(findServerBackedGoalUnit([clientMintedRow], 42)).toBeNull();
  });

  it('returns null for a goal whose parent still holds a negative placeholder id', () => {
    expect(findServerBackedGoalUnit([placeholderRow], 42)).toBeNull();
  });

  it('returns null when no row carries that goal', () => {
    expect(findServerBackedGoalUnit([serverRow], 77)).toBeNull();
  });

  it('returns null for a null goal id rather than matching an unidentified goal', () => {
    expect(findServerBackedGoalUnit([serverRow], null)).toBeNull();
  });

  it('returns null against an empty store', () => {
    expect(findServerBackedGoalUnit([], 42)).toBeNull();
  });
});
