/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import {
  PRACTICE_HABIT_CLEAR_A11Y,
  PRACTICE_HABIT_PICKER_HELP,
  PRACTICE_HABIT_PICKER_TITLE,
  practiceHabitChooseA11y,
} from '../practiceHabitCopy';
import PracticeHabitPicker from '../PracticeHabitPicker';

import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { WRITING_HABIT_PICKER_HELP } from '@/features/Journal/saveAsHabitCopy';

const ladder = (): Goal[] =>
  (['low', 'clear', 'stretch'] as const).map((tier, index) => ({
    id: 200 + index,
    title: tier,
    tier,
    target: index + 1,
    target_unit: 'minutes',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  }));

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
  habit(21, 'Sit'),
  habit(22, 'Walk'),
  habit(23, 'Locked', { revealed: false }),
];

const noop = (): void => undefined;

describe('PracticeHabitPicker', () => {
  it('asks which habit in the practice’s own words, and lists only linkable habits', () => {
    const { getByText, queryByText, getByTestId, queryByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(getByTestId('practice-habit-picker')).toBeTruthy();
    expect(getByText(PRACTICE_HABIT_PICKER_TITLE)).toBeTruthy();
    expect(getByText(PRACTICE_HABIT_PICKER_HELP)).toBeTruthy();
    expect(queryByText(WRITING_HABIT_PICKER_HELP)).toBeNull();
    expect(getByTestId('practice-habit-choose-21')).toBeTruthy();
    expect(getByTestId('practice-habit-choose-22')).toBeTruthy();
    expect(queryByTestId('practice-habit-choose-23')).toBeNull();
  });

  it('labels each row with what choosing it does to a practice session', () => {
    const { getByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(getByTestId('practice-habit-choose-21').props.accessibilityLabel).toBe(
      practiceHabitChooseA11y('Sit'),
    );
  });

  it('choosing a row hands back the habit', () => {
    const onChoose = jest.fn();
    const { getByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={onChoose} onCancel={noop} />,
    );

    fireEvent.press(getByTestId('practice-habit-choose-22'));

    expect(onChoose).toHaveBeenCalledWith(HABITS[1]);
  });

  it('offers no "new habit" row: a practice link is to a habit already kept', () => {
    const { queryByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />,
    );

    expect(queryByTestId('practice-habit-new')).toBeNull();
  });

  it('offers "Clear link" only when given, with the practice clear label', () => {
    const onClear = jest.fn();
    const without = render(<PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} />);
    expect(without.queryByTestId('practice-habit-clear')).toBeNull();

    const { getByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} onClear={onClear} />,
    );
    const clear = getByTestId('practice-habit-clear');
    expect(clear.props.accessibilityLabel).toBe(PRACTICE_HABIT_CLEAR_A11Y);

    fireEvent.press(clear);

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('Cancel is always there and answers nothing', () => {
    const onCancel = jest.fn();
    const onChoose = jest.fn();
    const { getByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={onChoose} onCancel={onCancel} />,
    );

    fireEvent.press(getByTestId('practice-habit-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('holds every choice while a save is in flight', () => {
    const { getByTestId } = render(
      <PracticeHabitPicker habits={HABITS} onChoose={noop} onCancel={noop} onClear={noop} busy />,
    );

    expect(getByTestId('practice-habit-choose-21').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(getByTestId('practice-habit-clear').props.accessibilityState).toEqual({
      disabled: true,
    });
  });
});
