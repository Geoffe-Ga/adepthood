/* eslint-env jest */
/**
 * Regression tests for ``ReorderHabitsModal`` covering two bugs reported
 * on the habits screen:
 *
 *  1. The order would snap back to the stage-default after the user
 *     dragged a habit and then picked a new start date (or any other
 *     state change that re-fired the initialisation effect). To users
 *     the manual reorder appeared to "freeze" because their drags had
 *     no visible effect once they touched anything else.
 *  2. Tapping the start-date button opened a date picker wrapped in a
 *     bare ``<Modal>`` with no dismissal affordance. On iOS the picker
 *     stayed on screen with no way to back out and the whole app froze.
 *     The fix swaps in the shared ``<DatePicker>`` component (which
 *     already wraps ``react-native-modal-datetime-picker`` with proper
 *     confirm/cancel handling) and is exercised here through its
 *     accessibility label.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, act } from '@testing-library/react-native';
import React from 'react';

import type { Habit } from '../../Habits.types';

jest.mock('react-native-draggable-flatlist', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ({ data, renderItem, onDragEnd, testID }: any) =>
    ReactLib.createElement(
      View,
      { testID: testID ?? 'reorder-list', data, onDragEnd },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data.map((item: any, index: number) =>
        ReactLib.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id ?? index },
        ),
      ),
    );
});

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');

jest.mock('react-native-modal-datetime-picker', () => {
  const ReactLib = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ModalDatePickerMock = ({ isVisible, onConfirm, onCancel }: any) =>
    isVisible
      ? ReactLib.createElement(
          ReactLib.Fragment,
          null,
          ReactLib.createElement(
            TouchableOpacity,
            { testID: 'modal-datetime-confirm', onPress: () => onConfirm(new Date('2026-06-01')) },
            ReactLib.createElement(Text, null, 'Confirm'),
          ),
          ReactLib.createElement(
            TouchableOpacity,
            { testID: 'modal-datetime-cancel', onPress: onCancel },
            ReactLib.createElement(Text, null, 'Cancel'),
          ),
        )
      : null;
  return { __esModule: true, default: ModalDatePickerMock };
});

const ReorderHabitsModal = require('../ReorderHabitsModal').default;

const makeHabit = (id: number, stage: string, name: string): Habit => ({
  id,
  stage,
  name,
  icon: '⭐',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01'),
  goals: [],
});

const HABITS: Habit[] = [
  makeHabit(1, 'Beige', 'A'),
  makeHabit(2, 'Purple', 'B'),
  makeHabit(3, 'Red', 'C'),
];

const getOrderedIds = (list: ReturnType<typeof render>): number[] => {
  const data = list.getByTestId('reorder-list').props.data as Habit[];
  return data.map((h) => h.id);
};

describe('ReorderHabitsModal — drag persistence (BUG: re-sort freezes)', () => {
  it('preserves the dragged order across multiple consecutive drags', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const list = result.getByTestId('reorder-list');

    // First drag: move habit 3 (Red) to the front.
    act(() => {
      list.props.onDragEnd({ data: [HABITS[2], HABITS[0], HABITS[1]] });
    });
    expect(getOrderedIds(result)).toEqual([3, 1, 2]);

    // Second drag: move habit 2 (Purple) to the front of the current order.
    const afterFirst = result.getByTestId('reorder-list').props.data as Habit[];
    act(() => {
      list.props.onDragEnd({ data: [afterFirst[2], afterFirst[0], afterFirst[1]] });
    });
    expect(getOrderedIds(result)).toEqual([2, 3, 1]);

    // Third drag: swap the first two.
    const afterSecond = result.getByTestId('reorder-list').props.data as Habit[];
    act(() => {
      list.props.onDragEnd({ data: [afterSecond[1], afterSecond[0], afterSecond[2]] });
    });
    expect(getOrderedIds(result)).toEqual([3, 2, 1]);
  });

  it('keeps the manual order when the start date changes', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const list = result.getByTestId('reorder-list');
    act(() => {
      list.props.onDragEnd({ data: [HABITS[2], HABITS[0], HABITS[1]] });
    });
    expect(getOrderedIds(result)).toEqual([3, 1, 2]);

    // Open the date picker and confirm a new date.
    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    // The user's manual order must survive the date change.
    expect(getOrderedIds(result)).toEqual([3, 1, 2]);
  });
});

describe('ReorderHabitsModal — date picker dismissal (BUG: app seizes)', () => {
  it('mounts the date picker only after the user opens it and dismisses cleanly on cancel', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(result.queryByTestId('modal-datetime-confirm')).toBeNull();

    fireEvent.press(result.getByTestId('reorder-start-date'));
    expect(result.getByTestId('modal-datetime-cancel')).toBeTruthy();

    fireEvent.press(result.getByTestId('modal-datetime-cancel'));
    expect(result.queryByTestId('modal-datetime-confirm')).toBeNull();
    // Order is unchanged after cancel.
    expect(getOrderedIds(result)).toEqual([1, 2, 3]);
  });

  it('persists the chosen date and recomputes start_date offsets', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    const data = result.getByTestId('reorder-list').props.data as Habit[];
    // First habit should anchor to the confirmed date (2026-06-01 in mock).
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-01');
    // Second habit is 21 days later.
    expect(new Date(data[1]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-22');
  });
});

describe('ReorderHabitsModal — save flow', () => {
  it('calls onSaveOrder with the current order and closes', () => {
    const onSave = jest.fn();
    const onClose = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={onClose} onSaveOrder={onSave} />,
    );

    const list = result.getByTestId('reorder-list');
    act(() => {
      list.props.onDragEnd({ data: [HABITS[1], HABITS[2], HABITS[0]] });
    });

    fireEvent.press(result.getByText('Save Order'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as Habit[];
    expect(saved.map((h) => h.id)).toEqual([2, 3, 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
