// Render-count guard for issue #468: a single-habit update must re-render only
// that row. HabitTile (and its UnlockedTile child) call useResponsive() on
// every render via useTileLayout, so spying on it counts actual tile renders.
// With React.memo + stable handlers, bumping one habit's reference re-renders
// exactly one tile's worth of work — not the whole list.
import { describe, expect, it, jest } from '@jest/globals';
import React, { useCallback, useState } from 'react';
import renderer from 'react-test-renderer';

import * as useResponsiveModule from '../../../design/useResponsive';
import type { Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';

const makeGoals = () => [
  {
    title: 'Low',
    tier: 'low' as const,
    target: 1,
    target_unit: 'u',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    title: 'Clear',
    tier: 'clear' as const,
    target: 2,
    target_unit: 'u',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    title: 'Stretch',
    tier: 'stretch' as const,
    target: 3,
    target_unit: 'u',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
];

function makeHabit(id: number): Habit {
  return {
    id,
    name: `Habit ${id}`,
    icon: '🧪',
    stage: 'Beige',
    streak: 0,
    energy_cost: 5,
    energy_return: 7,
    start_date: new Date(2020, 0, 1),
    goals: makeGoals(),
    completions: [],
    revealed: true,
  } as Habit;
}

let bumpHabit: (_id: number) => void = () => {};

function Harness({ initial }: { initial: readonly Habit[] }) {
  const [habits, setHabits] = useState<readonly Habit[]>(initial);
  // Stable handlers — exactly what HabitsScreen now passes so memo can work.
  const onOpenGoals = useCallback(() => {}, []);
  const onLongPress = useCallback(() => {}, []);
  const onIconPress = useCallback(() => {}, []);

  bumpHabit = (id: number) =>
    setHabits((current) => current.map((h) => (h.id === id ? { ...h, name: 'bumped' } : h)));

  return (
    <>
      {habits.map((habit, index) => (
        <HabitTile
          key={habit.id}
          habit={habit}
          stageColor="#abcdef"
          globalIndex={index}
          onOpenGoals={onOpenGoals}
          onLongPress={onLongPress}
          onIconPress={onIconPress}
        />
      ))}
    </>
  );
}

describe('HabitTile render isolation (issue #468)', () => {
  it('re-renders only the updated row when one habit changes', () => {
    const renderSpy = jest.spyOn(useResponsiveModule, 'default');
    const habits = [makeHabit(1), makeHabit(2), makeHabit(3)];

    renderer.act(() => {
      renderer.create(<Harness initial={habits} />);
    });

    const mountCalls = renderSpy.mock.calls.length;
    // Each row does a fixed amount of useResponsive work per render.
    const callsPerTile = mountCalls / habits.length;
    expect(Number.isInteger(callsPerTile)).toBe(true);

    renderSpy.mockClear();
    renderer.act(() => {
      bumpHabit(2);
    });
    const afterBumpCalls = renderSpy.mock.calls.length;

    // Exactly one tile re-rendered — not the whole list (which would be
    // ``mountCalls`` again). This is the regression the memo fix prevents.
    expect(afterBumpCalls).toBe(callsPerTile);
    expect(afterBumpCalls).toBeLessThan(mountCalls);

    renderSpy.mockRestore();
  });
});
