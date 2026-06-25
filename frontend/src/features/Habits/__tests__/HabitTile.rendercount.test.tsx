// Render-isolation guards for issue #468. HabitTile (and its UnlockedTile
// child) call useResponsive() on every render via useTileLayout, so spying on
// it counts actual tile renders. With React.memo + stable handlers, updating
// one habit's reference re-renders exactly one tile's worth of work — not the
// whole list. A second test pins the locked-tile invariant: locked rows never
// invoke the row handlers (they only expose the unlock dialog).
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

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

function makeHabit(id: number, overrides: Partial<Habit> = {}): Habit {
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
    ...overrides,
  } as Habit;
}

// Plain (non-memoized) list so it always re-renders on rerender — only the
// memoized HabitTiles decide whether to skip. Handlers are passed by the test
// as stable references, mirroring HabitsScreen's useCallback handlers.
function TileList({
  habits,
  onOpenGoals,
  onLongPress,
  onIconPress,
}: {
  habits: readonly Habit[];
  onOpenGoals: (_h: Habit) => void;
  onLongPress: (_h: Habit) => void;
  onIconPress: (_i: number) => void;
}) {
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
    // Defined once → stable references across the rerender (what useCallback
    // gives HabitsScreen in production).
    const onOpenGoals = (): void => {};
    const onLongPress = (): void => {};
    const onIconPress = (): void => {};
    const habits = [makeHabit(1), makeHabit(2), makeHabit(3)];

    const view = render(
      <TileList
        habits={habits}
        onOpenGoals={onOpenGoals}
        onLongPress={onLongPress}
        onIconPress={onIconPress}
      />,
    );

    const mountCalls = renderSpy.mock.calls.length;
    const callsPerTile = mountCalls / habits.length;
    expect(Number.isInteger(callsPerTile)).toBe(true);
    expect(callsPerTile).toBeGreaterThan(0);

    renderSpy.mockClear();
    const bumped = habits.map((h) => (h.id === 2 ? { ...h, name: 'bumped' } : h));
    view.rerender(
      <TileList
        habits={bumped}
        onOpenGoals={onOpenGoals}
        onLongPress={onLongPress}
        onIconPress={onIconPress}
      />,
    );
    const afterBumpCalls = renderSpy.mock.calls.length;

    // The changed tile did re-render (work happened)…
    expect(afterBumpCalls).toBeGreaterThan(0);
    // …but only that one tile — not the whole list.
    expect(afterBumpCalls).toBe(callsPerTile);
    expect(afterBumpCalls).toBeLessThan(mountCalls);

    renderSpy.mockRestore();
  });

  it('never invokes the row handlers for a locked tile', () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onOpenGoals = jest.fn();
    const onLongPress = jest.fn();
    const onIconPress = jest.fn();

    const { getByTestId } = render(
      <HabitTile
        habit={makeHabit(1, { revealed: false })}
        locked
        onOpenGoals={onOpenGoals}
        onLongPress={onLongPress}
        onIconPress={onIconPress}
        onUnlockHabit={jest.fn()}
      />,
    );

    // Locked tiles only expose the unlock affordance (long-press → dialog);
    // the three row handlers must stay wired out of the locked UI.
    fireEvent(getByTestId('habit-tile'), 'longPress');
    fireEvent.press(getByTestId('habit-tile'));

    expect(onOpenGoals).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onIconPress).not.toHaveBeenCalled();
  });
});
