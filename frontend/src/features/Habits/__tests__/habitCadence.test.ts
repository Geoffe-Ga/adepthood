import { describe, expect, it } from '@jest/globals';

import { habitCadence } from '../habitCadence';
import type { Goal } from '../Habits.types';

const goal = (tier: Goal['tier'], overrides: Partial<Goal> = {}): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: `${tier} goal`,
  tier,
  target: 3,
  target_unit: 'sessions',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
  ...overrides,
});

describe('habitCadence', () => {
  it('is daily for a per_day low tier', () => {
    expect(habitCadence([goal('low'), goal('clear'), goal('stretch')])).toEqual({ unit: 'day' });
  });

  it('reads a weekly cadence from the LOW tier: days needed and the per-day target', () => {
    const goals = [
      goal('low', { target: 3, frequency: 4, frequency_unit: 'per_week' }),
      goal('clear', { target: 5, frequency: 6, frequency_unit: 'per_week' }),
      goal('stretch', { target: 7, frequency: 7, frequency_unit: 'per_week' }),
    ];
    expect(habitCadence(goals)).toEqual({ unit: 'week', daysNeeded: 4, dayTarget: 3 });
  });

  it('reads a monthly cadence from the low tier regardless of goal order', () => {
    const goals = [
      goal('stretch', { target: 9, frequency: 20, frequency_unit: 'per_month' }),
      goal('low', { target: 2, frequency: 10, frequency_unit: 'per_month' }),
    ];
    expect(habitCadence(goals)).toEqual({ unit: 'month', daysNeeded: 10, dayTarget: 2 });
  });

  it('rounds a fractional frequency up to whole days', () => {
    const goals = [goal('low', { frequency: 2.2, frequency_unit: 'per_week' })];
    expect(habitCadence(goals)).toEqual({ unit: 'week', daysNeeded: 3, dayTarget: 3 });
  });

  it('never asks for fewer than one day per period', () => {
    const goals = [goal('low', { frequency: 0, frequency_unit: 'per_week' })];
    expect(habitCadence(goals)).toEqual({ unit: 'week', daysNeeded: 1, dayTarget: 3 });
  });

  it('falls back to daily when the low tier is missing', () => {
    expect(habitCadence([goal('clear', { frequency: 4, frequency_unit: 'per_week' })])).toEqual({
      unit: 'day',
    });
    expect(habitCadence([])).toEqual({ unit: 'day' });
  });

  it('falls back to daily for an unknown frequency_unit', () => {
    expect(habitCadence([goal('low', { frequency: 2, frequency_unit: 'per_fortnight' })])).toEqual({
      unit: 'day',
    });
    expect(habitCadence([goal('low', { frequency_unit: 'per_session' })])).toEqual({
      unit: 'day',
    });
  });
});
