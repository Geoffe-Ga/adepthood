/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

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

const makePastHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Test Habit',
  icon: '🧪',
  streak: 0,
  energy_cost: 5,
  energy_return: 7,
  start_date: new Date(2020, 0, 1),
  goals: makeGoals(),
  completions: [],
  revealed: true,
  ...overrides,
});

const makeFutureHabit = (overrides: Partial<Habit> = {}): Habit => ({
  ...makePastHabit(),
  id: 2,
  name: 'Future Habit',
  start_date: new Date(Date.now() + 86400000 * 30),
  revealed: false,
  ...overrides,
});

describe('HabitTile unlocked visual style (no early/natural distinction)', () => {
  // The old model drew a dashed border for a "manually early-unlocked"
  // habit (revealed ahead of its calendar start_date) versus a solid border
  // for one "naturally" reached by the calendar. Since the calendar no
  // longer participates in unlock at all, every revealed habit is unlocked
  // the same way — there is nothing left to distinguish visually.
  it('renders with a solid border for any revealed habit, regardless of start_date', () => {
    const future = makeFutureHabit({ revealed: true });
    const past = makePastHabit({ revealed: true });
    for (const habit of [future, past]) {
      const component = renderer.create(
        <HabitTile habit={habit} onOpenGoals={() => {}} onLongPress={() => {}} />,
      );
      const tile = component.root.findByProps({ testID: 'habit-tile' });
      expect(tile.props.style.borderStyle).toBeUndefined();
    }
  });
});

describe('HabitTile locked tile long-press', () => {
  // ConfirmDialog (#786) replaces Alert.alert, which is a no-op on RN Web mobile.
  const mentionsText = (component: ReturnType<typeof renderer.create>, text: string): boolean =>
    component.root.findAll(
      (n: { props: { children?: unknown } }) =>
        typeof n.props.children === 'string' && n.props.children.includes(text),
    ).length > 0;

  it('shows unlock confirmation on long-press of a locked (unrevealed) tile', () => {
    const onUnlockHabit = jest.fn();
    const habit = makeFutureHabit({ revealed: false });
    const component = renderer.create(
      <HabitTile habit={habit} locked onUnlockHabit={onUnlockHabit} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    renderer.act(() => {
      tile.props.onLongPress();
    });
    // The rendered dialog appears (not a silently-dropped Alert) and names the habit.
    expect(component.root.findByProps({ testID: 'unlock-habit-confirm' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'unlock-habit-confirm-button' })).toBeTruthy();
    expect(mentionsText(component, 'Future Habit')).toBe(true);
  });

  it('confirms unlock with non-"early" copy for a habit whose stage sits far ahead of any current stage', () => {
    const onUnlockHabit = jest.fn();
    // A Clear Light (final-stage) habit unlocking out of order — the calendar
    // and stage gates are both gone, so nothing blocks the manual unlock.
    const habit = makeFutureHabit({ revealed: false, stage: 'Clear Light' });
    const component = renderer.create(
      <HabitTile habit={habit} locked onUnlockHabit={onUnlockHabit} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    renderer.act(() => {
      tile.props.onLongPress();
    });
    // New tone: a plain "Unlock \"<name>\"?" question, no "early" framing and
    // no mention of a "recommended start date" (the calendar no longer unlocks).
    expect(mentionsText(component, `Unlock "${habit.name}"?`)).toBe(true);
    expect(mentionsText(component, 'Early')).toBe(false);
    expect(mentionsText(component, 'recommended start date')).toBe(false);

    const confirmButton = component.root.findByProps({ testID: 'unlock-habit-confirm-button' });
    renderer.act(() => {
      confirmButton.props.onPress();
    });
    expect(onUnlockHabit).toHaveBeenCalledWith(habit.id);
  });

  it('does not show unlock dialog on long-press of revealed tile', () => {
    const onLongPress = jest.fn();
    const habit = makePastHabit({ revealed: true });
    const component = renderer.create(
      <HabitTile habit={habit} onOpenGoals={() => {}} onLongPress={onLongPress} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    renderer.act(() => {
      tile.props.onLongPress();
    });
    expect(component.root.findAllByProps({ testID: 'unlock-habit-confirm' })).toHaveLength(0);
    expect(onLongPress).toHaveBeenCalled();
  });
});

describe('Reveal All / Lock Untouched actions', () => {
  it('revealAllHabits sets all habits to revealed: true', () => {
    const habits: Habit[] = [
      makePastHabit({ id: 1, revealed: true }),
      makeFutureHabit({ id: 2, revealed: false }),
      makeFutureHabit({ id: 3, revealed: false }),
    ];
    const result = habits.map((h) => ({ ...h, revealed: true }));
    expect(result.every((h) => h.revealed)).toBe(true);
  });

  it('lockUntouchedHabits re-locks only habits with zero completions, regardless of start_date', () => {
    const untouchedPast = makePastHabit({ id: 1, revealed: true, completions: [] });
    const touchedFuture = makeFutureHabit({
      id: 2,
      revealed: true,
      completions: [{ id: 'c1', timestamp: new Date(), completed_units: 1 }],
    });
    const untouchedFuture = makeFutureHabit({ id: 3, revealed: true, completions: [] });
    const habits: Habit[] = [untouchedPast, touchedFuture, untouchedFuture];
    const result = habits.map((h) => ({
      ...h,
      revealed: (h.completions?.length ?? 0) > 0,
    }));
    expect(result[0]?.revealed).toBe(false);
    expect(result[1]?.revealed).toBe(true);
    expect(result[2]?.revealed).toBe(false);
  });
});
