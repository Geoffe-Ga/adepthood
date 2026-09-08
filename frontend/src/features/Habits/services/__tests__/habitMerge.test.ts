import { describe, expect, it } from '@jest/globals';

import type { Habit, HabitMergePlan, OnboardingHabit } from '../../Habits.types';
import { planHabitMerge, toApiPayload } from '../habitMerge';

const MEDITATE = 'Meditate';

const habit = (over: Partial<Habit> = {}): Habit =>
  ({
    id: 7,
    name: MEDITATE,
    icon: '🧘',
    stage: 'Beige',
    streak: 4,
    revealed: true,
    energy_cost: 3,
    energy_return: 8,
    start_date: new Date('2025-01-01'),
    goals: [],
    completions: [],
    ...over,
  }) as Habit;

const pick = (over: Partial<OnboardingHabit> = {}): OnboardingHabit => ({
  id: 'existing-7',
  name: MEDITATE,
  icon: '🧘',
  energy_cost: 3,
  energy_return: 8,
  stage: 'Beige',
  start_date: new Date('2025-01-01'),
  ...over,
});

const rowFor = (ops: ReturnType<typeof planHabitMerge>, id: number): Habit | undefined =>
  ops.nextStore.find((row) => row.id === id);

describe('bringing a habit along', () => {
  it('moves a program habit onto the carryover pages', () => {
    // The choice has to do something. A user saying a habit is already part of
    // them and finding it still competing for a program slot was offered a fork
    // with one destination.
    const plan: HabitMergePlan = [{ kind: 'brought-along', habitId: 7, habit: pick() }];

    const ops = planHabitMerge(plan, [habit({ is_carryover: false })]);

    expect(rowFor(ops, 7)?.is_carryover).toBe(true);
  });

  it('tells the server, so the habit is still on the negative lap after a logout', () => {
    const plan: HabitMergePlan = [{ kind: 'brought-along', habitId: 7, habit: pick() }];

    const ops = planHabitMerge(plan, [habit({ is_carryover: false, sort_order: 0 })]);

    expect(ops.updates).toHaveLength(1);
    expect(toApiPayload(ops.updates[0]!)).toEqual(
      expect.objectContaining({ is_carryover: true, name: MEDITATE }),
    );
  });

  it('leaves the beginning the habit actually had, and its unlock state with it', () => {
    const plan: HabitMergePlan = [
      {
        kind: 'brought-along',
        habitId: 7,
        habit: pick({ stage: 'Purple', start_date: new Date('2026-09-01') }),
      },
    ];

    const ops = planHabitMerge(plan, [habit({ is_carryover: false })]);

    const row = rowFor(ops, 7);
    expect(row?.stage).toBe('Beige');
    expect(row?.start_date).toEqual(new Date('2025-01-01'));
    expect(row?.revealed).toBe(true);
    expect(row?.streak).toBe(4);
  });

  it('says nothing to the server about a habit already carried along and unchanged', () => {
    const plan: HabitMergePlan = [{ kind: 'brought-along', habitId: 7, habit: pick() }];

    const ops = planHabitMerge(plan, [habit({ is_carryover: true, sort_order: 0 })]);

    expect(ops.updates).toEqual([]);
  });
});

describe('re-rating a habit', () => {
  it('brings a carryover habit back onto the program lap', () => {
    // The fork has to run both ways. The two destinations are one radio pair,
    // same component and same weight, and Re-rate promises a place in the new
    // energy order -- so a habit that stays on the carryover lap after the user
    // picked Re-rate was offered a choice that does nothing.
    const plan: HabitMergePlan = [
      { kind: 're-rated', habitId: 7, habit: pick({ energy_cost: 9 }) },
    ];

    const ops = planHabitMerge(plan, [habit({ is_carryover: true })]);

    expect(rowFor(ops, 7)?.is_carryover).toBe(false);
    expect(rowFor(ops, 7)?.energy_cost).toBe(9);
  });

  it('tells the server the lap changed', () => {
    const plan: HabitMergePlan = [{ kind: 're-rated', habitId: 7, habit: pick() }];

    const ops = planHabitMerge(plan, [habit({ is_carryover: true, sort_order: 0 })]);

    expect(ops.updates).toHaveLength(1);
    expect(toApiPayload(ops.updates[0]!)).toEqual(expect.objectContaining({ is_carryover: false }));
  });

  it('still keeps the beginning of a habit the user has already lived', () => {
    // Lap membership and the date are separable, and only the date resets a
    // streak. Moving the lap is what the user asked for; moving the beginning
    // is not.
    const plan: HabitMergePlan = [
      {
        kind: 're-rated',
        habitId: 7,
        habit: pick({ stage: 'Purple', start_date: new Date('2026-09-01') }),
      },
    ];

    const ops = planHabitMerge(plan, [habit({ is_carryover: true, streak: 4 })]);

    expect(rowFor(ops, 7)?.start_date).toEqual(new Date('2025-01-01'));
    expect(rowFor(ops, 7)?.stage).toBe('Beige');
  });

  it('says nothing to the server about an ordinary habit whose rating did not move', () => {
    const plan: HabitMergePlan = [{ kind: 're-rated', habitId: 7, habit: pick() }];

    const ops = planHabitMerge(plan, [habit({ sort_order: 0 })]);

    expect(ops.updates).toEqual([]);
  });
});

describe('a habit that changes lap gets a place in the lap it enters', () => {
  it('does not carry its program position onto the carryover lap', () => {
    // sort_order restarts at zero in each partition, so a program slot carried
    // across collides with whatever carryover row already holds that number.
    const plan: HabitMergePlan = [{ kind: 'brought-along', habitId: 7, habit: pick() }];
    const existing = [
      habit({ id: 7, sort_order: 0, is_carryover: false }),
      habit({ id: 8, name: 'Morning pages', sort_order: 0, is_carryover: true }),
    ];

    const ops = planHabitMerge(plan, existing);

    // Named rather than de-duplicated: a set of slots is also unique when one
    // of them is `null`, so a uniqueness assertion alone is satisfied by
    // wiping the wrong row's position instead of numbering the new arrival.
    const byId = new Map(ops.nextStore.map((row) => [row.id, row]));
    expect(byId.get(8)?.sort_order).toBe(0);
    expect(byId.get(7)?.sort_order).toBe(1);
  });
});

describe('a store onboarded before slots existed', () => {
  it('gives a slot only to the rows this pass named, on a store that holds none', () => {
    // The legacy population: every row NULL, because these habits were created
    // before `sort_order` was stamped client-side. A pass that re-rates two of
    // them must number those two and leave the rest exactly as it found them --
    // silently numbering an unmentioned row would reshuffle a list the user
    // never asked to reorder.
    const existing = [
      habit({ id: 1, name: 'Alpha', sort_order: null }),
      habit({ id: 2, name: 'Bravo', sort_order: null }),
      habit({ id: 3, name: 'Charlie', sort_order: null }),
      habit({ id: 4, name: 'Delta', sort_order: null }),
      habit({ id: 5, name: 'Echo', sort_order: null }),
    ];
    const plan: HabitMergePlan = [
      { kind: 're-rated', habitId: 4, habit: pick({ name: 'Delta', energy_cost: 9 }) },
      { kind: 're-rated', habitId: 5, habit: pick({ name: 'Echo', energy_cost: 9 }) },
      { kind: 'retained', habitId: 1 },
      { kind: 'retained', habitId: 2 },
      { kind: 'retained', habitId: 3 },
    ];

    const ops = planHabitMerge(plan, existing);

    expect(ops.updates.map((u) => [u.id, u.sort_order])).toEqual([
      [4, 0],
      [5, 1],
    ]);
    expect(ops.creates).toEqual([]);
    expect(ops.nextStore.filter((h) => [1, 2, 3].includes(h.id)).map((h) => h.sort_order)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('an unmentioned demo tile', () => {
  it('drops an unmentioned demo tile from the next store', () => {
    // A demo tile is scaffolding, not a habit the user built. The rule that
    // keeps an unmentioned row alive exists so a forgetful plan cannot delete
    // real work; it must not also resurrect the placeholder the user has
    // already moved past.
    const existing = [
      habit({ id: 1, name: 'Alpha', sort_order: 0 }),
      habit({ id: -99, name: 'Demo tile', sort_order: 1, isDemoSeed: true }),
    ];
    const plan: HabitMergePlan = [
      { kind: 're-rated', habitId: 1, habit: pick({ name: 'Alpha', energy_cost: 9 }) },
    ];

    const ops = planHabitMerge(plan, existing);

    expect(ops.nextStore.map((h) => h.id)).toEqual([1]);
  });
});
