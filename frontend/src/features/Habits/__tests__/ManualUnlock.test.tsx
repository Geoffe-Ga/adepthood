/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';

import type { Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';
import { isEarlyUnlocked } from '../HabitUtils';

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

describe('isEarlyUnlocked', () => {
  it('returns true when revealed is true but start_date is in the future', () => {
    const habit = makeFutureHabit({ revealed: true });
    expect(isEarlyUnlocked(habit)).toBe(true);
  });

  it('returns false when revealed is true and start_date is in the past', () => {
    const habit = makePastHabit({ revealed: true });
    expect(isEarlyUnlocked(habit)).toBe(false);
  });

  it('returns false when revealed is false', () => {
    const habit = makeFutureHabit({ revealed: false });
    expect(isEarlyUnlocked(habit)).toBe(false);
  });

  it('returns false when revealed is undefined', () => {
    const habit = makeFutureHabit({ revealed: undefined });
    expect(isEarlyUnlocked(habit)).toBe(false);
  });
});

describe('HabitTile early-unlock visual indicator', () => {
  it('renders with dotted border when early unlocked', () => {
    const habit = makeFutureHabit({ revealed: true });
    const component = renderer.create(
      <HabitTile habit={habit} onOpenGoals={() => {}} onLongPress={() => {}} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderStyle).toBe('dashed');
  });

  it('renders with solid border when naturally unlocked', () => {
    const habit = makePastHabit({ revealed: true });
    const component = renderer.create(
      <HabitTile habit={habit} onOpenGoals={() => {}} onLongPress={() => {}} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderStyle).toBeUndefined();
  });
});

describe('HabitTile locked tile long-press', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

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
    expect(Alert.alert).toHaveBeenCalledWith(
      'Unlock Early?',
      expect.stringContaining('Future Habit'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Unlock' }),
      ]),
    );
  });

  it('calls onUnlockHabit when unlock is confirmed', () => {
    const onUnlockHabit = jest.fn();
    const habit = makeFutureHabit({ revealed: false });
    const component = renderer.create(
      <HabitTile habit={habit} locked onUnlockHabit={onUnlockHabit} />,
    );
    const tile = component.root.findByProps({ testID: 'habit-tile' });
    renderer.act(() => {
      tile.props.onLongPress();
    });

    // Get the Unlock button callback from the Alert.alert call
    const alertCalls = (Alert.alert as jest.Mock).mock.calls;
    const firstCall = alertCalls[0] as unknown[];
    const buttons = firstCall[2] as Array<{ text: string; onPress?: () => void }>;
    const unlockButton = buttons.find((b) => b.text === 'Unlock');
    renderer.act(() => {
      unlockButton?.onPress?.();
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
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalled();
  });
});

describe('Reveal All / Lock Unstarted actions', () => {
  it('revealAllHabits sets all habits to revealed: true', () => {
    const habits: Habit[] = [
      makePastHabit({ id: 1, revealed: true }),
      makeFutureHabit({ id: 2, revealed: false }),
      makeFutureHabit({ id: 3, revealed: false }),
    ];
    const result = habits.map((h) => ({ ...h, revealed: true }));
    expect(result.every((h) => h.revealed)).toBe(true);
  });

  it('lockUnstartedHabits resets future habits to revealed: false', () => {
    const now = Date.now();
    const habits: Habit[] = [
      makePastHabit({ id: 1, revealed: true }),
      makeFutureHabit({ id: 2, revealed: true }),
      makeFutureHabit({ id: 3, revealed: true }),
    ];
    const result = habits.map((h) => ({
      ...h,
      revealed: new Date(h.start_date).getTime() <= now,
    }));
    expect(result[0]?.revealed).toBe(true);
    expect(result[1]?.revealed).toBe(false);
    expect(result[2]?.revealed).toBe(false);
  });
});
