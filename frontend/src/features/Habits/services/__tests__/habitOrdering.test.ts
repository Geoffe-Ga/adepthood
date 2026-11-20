/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { dayKeyInTZ } from '../../../../utils/dateUtils';
import type { Habit } from '../../Habits.types';
import {
  displaySlots,
  insertAt,
  isPassRow,
  shiftPassRows,
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

describe('shiftPassRows — the habits move with a rescheduled pass (#3762)', () => {
  const ZONE = 'America/New_York';
  const OLD = '2026-11-19';
  /** An account-zone midnight, the way the server stores a row's start. */
  const midnight = (day: string): Date =>
    new Date(new Date(`${day}T00:00:00Z`).getTime() + 5 * 60 * 60 * 1000);
  const keys = (habits: readonly Habit[]) => habits.map((h) => dayKeyInTZ(h.start_date, ZONE));
  const ROWS = [
    // The running pass: began before the pending day.
    row({ id: 1, start_date: midnight('2026-09-13') }),
    row({ id: 2, start_date: midnight('2026-11-18') }),
    // Laid for the pass: from the pending day on, 21 days apart.
    row({ id: 3, start_date: midnight(OLD) }),
    row({ id: 4, start_date: midnight('2026-12-10') }),
  ];

  it('moves every row on or after the old day by +21 days and leaves earlier rows alone', () => {
    const shifted = shiftPassRows(ROWS, OLD, '2026-12-10', ZONE);

    expect(keys(shifted)).toEqual(['2026-09-13', '2026-11-18', '2026-12-10', '2026-12-31']);
    // Unmoved rows are the very objects passed in, so a writer can tell them apart.
    expect(shifted[0]).toBe(ROWS[0]);
    expect(shifted[1]).toBe(ROWS[1]);
    expect(shifted.map((h) => h.id)).toEqual([1, 2, 3, 4]);
  });

  it('moves them back by 7 calendar days, across the DST change, keeping the time of day', () => {
    const late = [row({ id: 5, start_date: midnight('2026-11-05') })];

    const shifted = shiftPassRows(late, '2026-11-05', '2026-10-29', ZONE);

    expect(keys(shifted)).toEqual(['2026-10-29']);
    // Still the account-zone midnight, although New York changed offset between.
    expect(new Date(shifted[0]!.start_date).toISOString()).toBe('2026-10-29T04:00:00.000Z');
  });

  it('moves nothing when the day does not change', () => {
    const shifted = shiftPassRows(ROWS, OLD, OLD, ZONE);

    shifted.forEach((habit, index) => expect(habit).toBe(ROWS[index]));
  });

  it('leaves demo tiles and undated rows alone', () => {
    const demo = row({ id: 6, start_date: midnight('2026-12-01'), isDemoSeed: true });
    const undated = row({ id: 7, start_date: new Date('not a date') });

    expect(isPassRow(demo, OLD, ZONE)).toBe(false);
    expect(isPassRow(undated, OLD, ZONE)).toBe(false);
    expect(shiftPassRows([demo, undated], OLD, '2026-12-10', ZONE)).toEqual([demo, undated]);
  });
});
