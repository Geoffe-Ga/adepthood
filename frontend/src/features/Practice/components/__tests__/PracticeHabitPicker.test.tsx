import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import PracticeHabitPicker, { type PracticeHabitPickerProps } from '../PracticeHabitPicker';

import type { Habit } from '@/features/Habits/Habits.types';
import { OFFER_ACTION_DISABLED_OPACITY } from '@/features/Journal/OfferAction';

const habit: Habit = {
  id: 25,
  name: 'Metta',
  stage: 'beige',
  icon: 'heart',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-10-14T00:00:00Z'),
  revealed: true,
  goals: [],
};

function props(overrides: Partial<PracticeHabitPickerProps> = {}): PracticeHabitPickerProps {
  return {
    practiceName: 'Evening sit',
    habits: [habit],
    onChoose: jest.fn(),
    onNew: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
}

describe('PracticeHabitPicker', () => {
  it('lists eligible habits by their names and chooses the actual row', () => {
    const p = props();
    const screen = render(<PracticeHabitPicker {...p} />);
    expect(screen.getByText('Link a habit')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Link Metta to this practice'));
    expect(p.onChoose).toHaveBeenCalledWith(habit);
  });

  it('offers a new habit named for this practice without creating it on render', () => {
    const p = props();
    const screen = render(<PracticeHabitPicker {...p} />);
    expect(p.onNew).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('New habit: Evening sit'));
    expect(p.onNew).toHaveBeenCalledTimes(1);
  });

  it('offers clearing only when the current practice has a link', () => {
    const onClear = jest.fn();
    const screen = render(<PracticeHabitPicker {...props({ onClear })} />);
    fireEvent.press(screen.getByText('Clear link'));
    expect(onClear).toHaveBeenCalledTimes(1);
    screen.rerender(<PracticeHabitPicker {...props()} />);
    expect(screen.queryByText('Clear link')).toBeNull();
  });

  it('can be declined with one tap without selecting or creating anything', () => {
    const p = props();
    const screen = render(<PracticeHabitPicker {...p} />);
    expect(screen.getByTestId('practice-habit-cancel')).not.toHaveStyle({
      opacity: OFFER_ACTION_DISABLED_OPACITY,
    });
    fireEvent.press(screen.getByText('Cancel'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onChoose).not.toHaveBeenCalled();
    expect(p.onNew).not.toHaveBeenCalled();
  });

  it('disables every write while busy', () => {
    const p = props({ busy: true, onClear: jest.fn() });
    const screen = render(<PracticeHabitPicker {...p} />);
    for (const id of ['practice-habit-choose-25', 'practice-habit-new', 'practice-habit-clear']) {
      expect(screen.getByTestId(id)).toBeDisabled();
      fireEvent.press(screen.getByTestId(id));
    }
    expect(p.onChoose).not.toHaveBeenCalled();
    expect(p.onNew).not.toHaveBeenCalled();
    expect(p.onClear).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while a link change is pending (#3382)', () => {
    const p = props({ busy: true, onClear: jest.fn() });
    const screen = render(<PracticeHabitPicker {...p} />);
    const cancel = screen.getByTestId('practice-habit-cancel');
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveStyle({ opacity: OFFER_ACTION_DISABLED_OPACITY });
    fireEvent.press(cancel);
    screen.getByTestId('practice-habit-picker-modal').props.onRequestClose();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it('can be dismissed again by Cancel or the system back once the request settles', () => {
    const p = props({ busy: true });
    const screen = render(<PracticeHabitPicker {...p} />);
    screen.rerender(<PracticeHabitPicker {...p} busy={false} />);
    const cancel = screen.getByTestId('practice-habit-cancel');
    expect(cancel).toBeEnabled();
    fireEvent.press(cancel);
    screen.getByTestId('practice-habit-picker-modal').props.onRequestClose();
    expect(p.onCancel).toHaveBeenCalledTimes(2);
  });

  it('shows a contained retry message without hiding the choices', () => {
    const screen = render(
      <PracticeHabitPicker {...props({ error: 'Could not save that link.' })} />,
    );
    expect(screen.getByText('Could not save that link.')).toBeTruthy();
    expect(screen.getByText('Metta')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });
});
