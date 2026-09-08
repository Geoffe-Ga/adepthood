/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { Habit } from '../../Habits.types';
import { displaySlots, insertAt, stagePreview, stampPositionalOrder } from '../habitOrdering';

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
