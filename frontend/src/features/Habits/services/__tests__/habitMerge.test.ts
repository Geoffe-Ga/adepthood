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
  it('does not take a lived habit out of the lap it is living in', () => {
    // The reverse of bring-along is deliberately not symmetric: a habit that
    // began before the program keeps a pre-program start date, and putting that
    // date on a program lap drags the whole course calendar back to a day the
    // program had not started.
    const plan: HabitMergePlan = [
      { kind: 're-rated', habitId: 7, habit: pick({ energy_cost: 9 }) },
    ];

    const ops = planHabitMerge(plan, [habit({ is_carryover: true })]);

    expect(rowFor(ops, 7)?.is_carryover).toBe(true);
    expect(rowFor(ops, 7)?.energy_cost).toBe(9);
  });
});
