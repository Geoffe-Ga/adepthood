import { describe, expect, it } from '@jest/globals';

import { PRACTICE_HABIT_DEFAULTS } from '../constants';
import { practiceHabitAmount } from '../habitSessionAmount';

const MINUTE = 60_000;

describe('practice habit amounts', () => {
  it.each([
    [1, 1],
    [29_000, 1],
    [MINUTE, 1],
    [89_000, 1],
    [90_000, 2],
    [20 * MINUTE, 20],
    [21 * MINUTE - 1, 21],
  ])('credits %i actual milliseconds as %i rounded minutes', (elapsed, expected) => {
    expect(practiceHabitAmount('minutes', elapsed)).toBe(expected);
  });

  it.each([1, MINUTE, 20 * MINUTE])(
    'credits one session for a positive %i ms sitting',
    (elapsed) => {
      expect(practiceHabitAmount('sessions', elapsed)).toBe(1);
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity])(
    'does not credit an invalid %s duration',
    (elapsed) => {
      expect(practiceHabitAmount('sessions', elapsed)).toBeNull();
      expect(practiceHabitAmount('minutes', elapsed)).toBeNull();
    },
  );

  it('does not invent a conversion for another habit unit', () => {
    expect(practiceHabitAmount('units', MINUTE)).toBeNull();
  });

  it('defaults a new practice habit to one session four times per week', () => {
    expect(PRACTICE_HABIT_DEFAULTS).toEqual({
      unit: 'sessions',
      low: 1,
      clear: 1,
      stretch: 1,
      frequency: 4,
      frequencyUnit: 'per_week',
    });
  });
});
