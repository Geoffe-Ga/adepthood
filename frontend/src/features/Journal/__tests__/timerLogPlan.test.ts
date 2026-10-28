import { describe, expect, it } from '@jest/globals';

import { planTimerLog } from '../writingHabitCheckOff';
import { toWritingSessionResult } from '../writingSession';

import type { Habit } from '@/features/Habits/Habits.types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

function habit(unit = 'minutes'): Habit {
  return {
    id: 42,
    name: 'Journaling',
    icon: '✍️',
    stage: 'Beige',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date('2026-01-01'),
    revealed: true,
    goals: (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
      id: 101 + index,
      title: tier,
      tier,
      target: [10, 20, 45][index]!,
      target_unit: unit,
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    })),
    completions: [],
  };
}
const result = (minutes: number, plannedMinutes = 20) =>
  toWritingSessionResult({ plannedMinutes, elapsedMs: minutes * MS_PER_MINUTE });

describe('the amount a writing timer actually measured', () => {
  it('logs full elapsed minutes regardless of an already-met low tier', () => {
    const linked = habit();
    linked.completions = [{ id: 'earlier', timestamp: new Date(), completed_units: 20 }];
    expect(planTimerLog(linked, result(10))).toBe(10);
  });
  it('rounds an early stop using the timer result, with a one-minute minimum', () => {
    expect(planTimerLog(habit(), result(3.6))).toBe(4);
    expect(planTimerLog(habit(), result(0.1))).toBe(1);
  });
  it('logs one session only after the requested duration completes', () => {
    expect(planTimerLog(habit('sessions'), result(20))).toBe(1);
    expect(planTimerLog(habit('sessions'), result(19))).toBeNull();
  });
  it('does not invent activity for a zero-length timer', () => {
    expect(planTimerLog(habit(), result(0))).toBeNull();
  });
  it.each(['pages', 'units', 'hours'])('cannot measure a %s habit', (unit) => {
    expect(planTimerLog(habit(unit), result(20))).toBeNull();
  });
  it('rejects a mixed-unit ladder instead of choosing an arbitrary tier', () => {
    const linked = habit();
    linked.goals[2]!.target_unit = 'sessions';
    expect(planTimerLog(linked, result(20))).toBeNull();
  });
  it('does not bypass locking or the provenance of the linked goal IDs', () => {
    expect(planTimerLog({ ...habit(), revealed: false }, result(20))).toBeNull();
    expect(planTimerLog({ ...habit(), hasClientMintedIds: true }, result(20))).toBeNull();
  });
});
