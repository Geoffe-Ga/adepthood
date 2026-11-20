/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { dayKeyInTZ } from '../../../../utils/dateUtils';
import type { Habit } from '../../Habits.types';
import {
  displaySlots,
  insertAt,
  isRecalculated,
  recalculatePassRows,
  stagePreview,
  stampPositionalOrder,
} from '../habitOrdering';

/** A habit row with only the fields ordering cares about. */
function row(overrides: Partial<Habit> & { id: number }): Habit {
  return {
    stage: 'Beige',
    name: `Habit ${overrides.id}`,
    icon: '✨',
    streak: 0,
    energy_cost: 5,
    energy_return: 5,
    start_date: new Date('2026-01-01T00:00:00Z'),
    goals: [],
    ...overrides,
  };
}

describe('displaySlots — each partition counts itself', () => {
  it('numbers program rows from zero and carryover rows backwards from minus one', () => {
    const rows = [
      row({ id: 1, is_carryover: true }),
      row({ id: 2 }),
      row({ id: 3, is_carryover: true }),
      row({ id: 4 }),
    ];

    expect(displaySlots(rows)).toEqual([-1, 0, -2, 1]);
  });

  it('is empty for an empty list', () => {
    expect(displaySlots([])).toEqual([]);
  });
});

describe('stagePreview — the stage each row would land on', () => {
  it('walks the gradient for program rows and mirrors it for carryover rows', () => {
    const rows = [row({ id: 1, is_carryover: true }), row({ id: 2 }), row({ id: 3 })];

    expect(stagePreview(rows)).toEqual(['Clear Light', 'Beige', 'Purple']);
  });

  it('wraps an eleventh program row back to Beige rather than overflowing', () => {
    const rows = Array.from({ length: 11 }, (_, index) => row({ id: index + 1 }));

    expect(stagePreview(rows)[10]).toBe('Beige');
  });
});

describe('insertAt — placing one row among the others', () => {
  it('puts the row first at position zero', () => {
    expect(insertAt(['a', 'b'], 'new', 0)).toEqual(['new', 'a', 'b']);
  });

  it('puts the row last at the end position', () => {
    expect(insertAt(['a', 'b'], 'new', 2)).toEqual(['a', 'b', 'new']);
  });

  it('clamps a position past the end rather than leaving a hole', () => {
    expect(insertAt(['a', 'b'], 'new', 9)).toEqual(['a', 'b', 'new']);
  });

  it('clamps a negative position to the front', () => {
    expect(insertAt(['a', 'b'], 'new', -3)).toEqual(['new', 'a', 'b']);
  });
});

describe('stampPositionalOrder — sort_order globally, stage by partition', () => {
  it('numbers sort_order across the whole mixed list, not within each partition', () => {
    const rows = [row({ id: 1, is_carryover: true }), row({ id: 2 }), row({ id: 3 })];

    expect(stampPositionalOrder(rows).map((h) => h.sort_order)).toEqual([0, 1, 2]);
  });

  it('restamps stage from the row position so a moved habit stops naming its old stage', () => {
    const rows = [row({ id: 1, stage: 'Beige' }), row({ id: 2, stage: 'Purple' })];

    const stamped = stampPositionalOrder([rows[1] as Habit, rows[0] as Habit]);

    expect(stamped.map((h) => h.stage)).toEqual(['Beige', 'Purple']);
    expect(stamped.map((h) => h.id)).toEqual([2, 1]);
  });

  it('stamps a carryover row from its own mirrored slot, not from its list index', () => {
    const rows = [row({ id: 1, is_carryover: true, stage: 'Beige' }), row({ id: 2 })];

    const stamped = stampPositionalOrder(rows);

    expect(stamped[0]?.stage).toBe('Clear Light');
    expect(stamped[0]?.sort_order).toBe(0);
    expect(stamped[1]?.stage).toBe('Beige');
    expect(stamped[1]?.sort_order).toBe(1);
  });

  it('leaves the input array untouched', () => {
    const rows = [row({ id: 1, stage: 'Beige' }), row({ id: 2, stage: 'Purple' })];

    stampPositionalOrder([rows[1] as Habit, rows[0] as Habit]);

    expect(rows.map((h) => h.stage)).toEqual(['Beige', 'Purple']);
  });
});

describe('recalculatePassRows — the habits waiting for a pass cascade from its day (#3762)', () => {
  const ZONE = 'UTC';
  const NEW = '2026-12-10';
  const at = (day: string): Date => new Date(`${day}T00:00:00Z`);
  const keys = (habits: readonly Habit[]) => habits.map((h) => dayKeyInTZ(h.start_date, ZONE));
  const locked = (id: number, day: string, extra: Partial<Habit> = {}) =>
    row({ id, start_date: at(day), revealed: false, ...extra });
  const unlocked = (id: number, day: string) => row({ id, start_date: at(day), revealed: true });

  it('re-cascades each locked row from the new day at its own slot, keeping unlocked rows', () => {
    const rows = [
      // Slot 0: unlocked and being met every day -- it keeps its date.
      unlocked(1, '2026-09-13'),
      // Slots 1 and 2: locked, laid for the pass from the old day.
      locked(2, '2026-12-10'),
      locked(3, '2026-12-31'),
      // Slot 3: unlocked although dated after the old day -- it stays put.
      unlocked(4, '2027-01-21'),
    ];

    const moved = recalculatePassRows(rows, '2027-01-07', ZONE);

    // Slot k lands on NEW + its interval: 21 days for slot 1, 42 for slot 2.
    expect(keys(moved)).toEqual(['2026-09-13', '2027-01-28', '2027-02-18', '2027-01-21']);
    expect(moved[0]).toBe(rows[0]);
    expect(moved[3]).toBe(rows[3]);
  });

  it('starts the first locked row on the new day when it holds slot 0', () => {
    const rows = [locked(1, '2026-11-19'), locked(2, '2026-12-10')];

    expect(keys(recalculatePassRows(rows, NEW, ZONE))).toEqual(['2026-12-10', '2026-12-31']);
  });

  it('spaces habits 9 and 10 42 days apart, like the Reorder lay', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      index < 8 ? unlocked(index + 1, '2026-01-01') : locked(index + 1, '2026-01-01'),
    );

    const moved = keys(recalculatePassRows(rows, NEW, ZONE));

    // 8 x 21 days to slot 8, then 42 more to slot 9.
    expect(moved.slice(8)).toEqual(['2027-05-27', '2027-07-08']);
    expect(moved.slice(0, 8)).toEqual(Array(8).fill('2026-01-01'));
  });

  it('leaves demo tiles, carryover rows and rows already on their day alone', () => {
    const demo = locked(1, '2026-01-01', { isDemoSeed: true });
    const carry = locked(2, '2025-06-01', { is_carryover: true });
    const onDay = locked(3, NEW);

    const moved = recalculatePassRows([carry, onDay, demo], NEW, ZONE);

    expect(isRecalculated(demo)).toBe(false);
    expect(isRecalculated(carry)).toBe(false);
    expect(isRecalculated(unlocked(4, NEW))).toBe(false);
    expect(isRecalculated(onDay)).toBe(true);
    moved.forEach((habit, index) => expect(habit).toBe([carry, onDay, demo][index]));
  });
});
