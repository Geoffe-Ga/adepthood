import { describe, expect, it } from '@jest/globals';

import type { Habit } from '../Habits.types';
import { isTimerLinkableHabit } from '../timerHabit';

function habit(): Habit {
  return {
    id: 42,
    name: 'Own timer habit',
    icon: '•',
    stage: 'Beige',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date('2026-01-01'),
    revealed: true,
    goals: (['low', 'clear', 'stretch'] as const).map((tier, i) => ({
      id: 101 + i,
      title: tier,
      tier,
      target: i + 1,
      target_unit: 'minutes',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    })),
  };
}

describe('habits a measured timer can feed', () => {
  it.each(['minutes', 'sessions'])('supports %s per day or week', (unit) => {
    for (const cadence of ['per_day', 'per_week']) {
      const candidate = habit();
      candidate.goals = candidate.goals.map((goal) => ({
        ...goal,
        target_unit: unit,
        frequency_unit: cadence,
      }));
      expect(isTimerLinkableHabit(candidate)).toBe(true);
    }
  });
  it('refuses mismatched tier units or cadences', () => {
    const mixedUnit = habit();
    mixedUnit.goals[1]!.target_unit = 'sessions';
    expect(isTimerLinkableHabit(mixedUnit)).toBe(false);
    const mixedCadence = habit();
    mixedCadence.goals[1]!.frequency_unit = 'per_week';
    expect(isTimerLinkableHabit(mixedCadence)).toBe(false);
  });
  it('refuses a legacy goal whose server provenance cannot be established', () => {
    const candidate = habit();
    candidate.goals[0]!.id = -1;
    expect(isTimerLinkableHabit(candidate)).toBe(false);
  });
  it('refuses a subtractive tier even when the low tier adds up', () => {
    const candidate = habit();
    candidate.goals[2]!.is_additive = false;
    expect(isTimerLinkableHabit(candidate)).toBe(false);
  });
});
