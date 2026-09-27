/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import {
  WRITING_HABIT_CANCEL_A11Y,
  WRITING_HABIT_CLEAR_A11Y,
  WRITING_HABIT_NEW,
  WRITING_HABIT_NEW_A11Y,
  WRITING_HABIT_PICKER_TITLE,
  writingHabitChooseA11y,
} from '../saveAsHabitCopy';
import WritingHabitPicker from '../WritingHabitPicker';

import { touchTarget } from '@/design/tokens';
import type { Goal, Habit } from '@/features/Habits/Habits.types';

const makeGoal = (tier: 'low' | 'clear' | 'stretch', isAdditive = true): Goal => ({
  id: tier === 'low' ? 1 : tier === 'clear' ? 2 : 3,
  title: tier,
  tier,
  target: 1,
  target_unit: 'units',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: isAdditive,
});

const ladder = (isAdditive = true): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier) => makeGoal(tier, isAdditive));

const habit = (id: number, name: string, overrides: Partial<Habit> = {}): Habit => ({
  id,
  stage: 'Beige',
  name,
  icon: '•',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2025-01-01'),
  goals: ladder(),
  completions: [],
  revealed: true,
  ...overrides,
});

const HABITS: Habit[] = [
  habit(11, 'Morning pages'),
  habit(12, 'Stretch'),
  habit(13, 'Less coffee', { goals: ladder(false) }),
  habit(14, 'Demo', { isDemoSeed: true }),
  habit(15, 'Not begun yet', { revealed: false }),
];

const noop = (): void => undefined;

describe('WritingHabitPicker', () => {
  it('asks which habit, and lists the writer’s own linkable habits by their own names, in order', () => {
    const { getByText, getAllByTestId } = render(
      <WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} onNew={noop} />,
    );

    expect(getByText(WRITING_HABIT_PICKER_TITLE)).toBeTruthy();
    const rows = getAllByTestId(/^writing-habit-(choose-\d+|new|clear|cancel)$/);
    expect(rows.map((row) => row.props.testID)).toEqual([
      'writing-habit-choose-11',
      'writing-habit-choose-12',
      'writing-habit-new',
      'writing-habit-cancel',
    ]);
    expect(getByText('Morning pages')).toBeTruthy();
    expect(getByText(WRITING_HABIT_NEW)).toBeTruthy();
  });

  it('leaves out subtractive and demo habits, which a check-off cannot honestly apply to', () => {
    const { queryByTestId } = render(
      <WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(queryByTestId('writing-habit-choose-13')).toBeNull();
    expect(queryByTestId('writing-habit-choose-14')).toBeNull();
  });

  it('leaves out a locked habit, which nothing may be logged against until it is open', () => {
    const { queryByTestId, queryByText } = render(
      <WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(queryByTestId('writing-habit-choose-15')).toBeNull();
    expect(queryByText('Not begun yet')).toBeNull();
  });

  it('offers a new habit only when there is somewhere for it to go', () => {
    const { queryByTestId } = render(
      <WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(queryByTestId('writing-habit-new')).toBeNull();
  });

  it('offers to clear the link only when asked to', () => {
    const without = render(<WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />);
    expect(without.queryByTestId('writing-habit-clear')).toBeNull();
    without.unmount();

    const withClear = render(
      <WritingHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} onClear={noop} />,
    );
    const ids = withClear
      .getAllByTestId(/^writing-habit-(choose-\d+|new|clear|cancel)$/)
      .map((row) => row.props.testID);
    expect(ids.slice(-2)).toEqual(['writing-habit-clear', 'writing-habit-cancel']);
  });

  it('with nothing linkable, still offers a new habit and a way back', () => {
    const { getAllByTestId } = render(
      <WritingHabitPicker habits={[]} onChoose={noop} onCancel={noop} onNew={noop} />,
    );

    expect(getAllByTestId(/^writing-habit-/).map((row) => row.props.testID)).toEqual(
      expect.arrayContaining(['writing-habit-new', 'writing-habit-cancel']),
    );
  });

  it('every row is a button with a label saying what it does, at the touch-target floor', () => {
    const { getByTestId } = render(
      <WritingHabitPicker
        habits={HABITS}
        onChoose={noop}
        onCancel={noop}
        onNew={noop}
        onClear={noop}
      />,
    );

    const expected: Record<string, string> = {
      'writing-habit-choose-11': writingHabitChooseA11y('Morning pages'),
      'writing-habit-choose-12': writingHabitChooseA11y('Stretch'),
      'writing-habit-new': WRITING_HABIT_NEW_A11Y,
      'writing-habit-clear': WRITING_HABIT_CLEAR_A11Y,
      'writing-habit-cancel': WRITING_HABIT_CANCEL_A11Y,
    };
    for (const [testID, label] of Object.entries(expected)) {
      const row = getByTestId(testID);
      expect(row.props.accessibilityRole).toBe('button');
      expect(row.props.accessibilityLabel).toBe(label);
      expect(StyleSheet.flatten(row.props.style).minHeight).toBe(touchTarget.minimum);
    }
  });

  it('each row calls its own handler', () => {
    const onChoose = jest.fn();
    const onNew = jest.fn();
    const onClear = jest.fn();
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <WritingHabitPicker
        habits={HABITS}
        onChoose={onChoose}
        onCancel={onCancel}
        onNew={onNew}
        onClear={onClear}
      />,
    );

    fireEvent.press(getByTestId('writing-habit-choose-12'));
    fireEvent.press(getByTestId('writing-habit-new'));
    fireEvent.press(getByTestId('writing-habit-clear'));
    fireEvent.press(getByTestId('writing-habit-cancel'));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect((onChoose.mock.calls[0]?.[0] as Habit).id).toBe(12);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('holds every choice while a save is in flight, so one tap cannot be spent twice', () => {
    const onChoose = jest.fn();
    const onClear = jest.fn();
    const { getByTestId } = render(
      <WritingHabitPicker
        habits={HABITS}
        onChoose={onChoose}
        onCancel={noop}
        onClear={onClear}
        busy
      />,
    );

    fireEvent.press(getByTestId('writing-habit-choose-11'));
    fireEvent.press(getByTestId('writing-habit-clear'));

    expect(onChoose).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(getByTestId('writing-habit-choose-11').props.accessibilityState).toEqual({
      disabled: true,
    });
  });
});
