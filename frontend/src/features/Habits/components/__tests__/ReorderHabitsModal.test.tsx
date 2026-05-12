/* eslint-env jest */
/**
 * Regression tests for ``ReorderHabitsModal`` covering three bugs reported
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
 *     PR #299 added confirm/cancel affordances via
 *     ``react-native-modal-datetime-picker``.
 *  3. After PR #299 the picker *still* did not appear on iOS during
 *     habit edit mode because it was rendered as a descendant of the
 *     parent ``<Modal>``; nested ``UIViewController`` presentations
 *     animate underneath each other on iOS.  The picker is now
 *     mounted as a SIBLING of the parent modal.  These tests assert the
 *     sibling structure, that past dates are accepted, and that
 *     confirming a date propagates to the shared program-anchor store.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, act } from '@testing-library/react-native';
import React from 'react';

import { useProgramStore } from '../../../../store/useProgramStore';
import type { Habit } from '../../Habits.types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

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

// Capture the most recent props passed to the picker so structural / prop
// tests can introspect them without relying on rendered output.
const lastModalDatePickerProps: { current: Record<string, unknown> | null } = { current: null };

jest.mock('react-native-modal-datetime-picker', () => {
  const ReactLib = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ModalDatePickerMock = (props: any) => {
    lastModalDatePickerProps.current = props;
    return props.isVisible
      ? ReactLib.createElement(
          View,
          { testID: 'modal-datetime-picker-root' },
          ReactLib.createElement(
            TouchableOpacity,
            {
              testID: 'modal-datetime-confirm',
              onPress: () => props.onConfirm(new Date(2026, 5, 1)),
            },
            ReactLib.createElement(Text, null, 'Confirm'),
          ),
          ReactLib.createElement(
            TouchableOpacity,
            { testID: 'modal-datetime-cancel', onPress: props.onCancel },
            ReactLib.createElement(Text, null, 'Cancel'),
          ),
          ReactLib.createElement(
            TouchableOpacity,
            {
              testID: 'modal-datetime-confirm-past',
              onPress: () => props.onConfirm(new Date(2020, 0, 1)),
            },
            ReactLib.createElement(Text, null, 'Confirm past'),
          ),
        )
      : null;
  };
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

beforeEach(() => {
  lastModalDatePickerProps.current = null;
  act(() => useProgramStore.getState().hydrateProgramStartDate(null));
});

describe('ReorderHabitsModal — drag persistence (BUG: re-sort freezes)', () => {
  it('preserves the dragged order across multiple consecutive drags', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const list = result.getByTestId('reorder-list');

    act(() => {
      list.props.onDragEnd({ data: [HABITS[2], HABITS[0], HABITS[1]] });
    });
    expect(getOrderedIds(result)).toEqual([3, 1, 2]);

    const afterFirst = result.getByTestId('reorder-list').props.data as Habit[];
    act(() => {
      list.props.onDragEnd({ data: [afterFirst[2], afterFirst[0], afterFirst[1]] });
    });
    expect(getOrderedIds(result)).toEqual([2, 3, 1]);

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

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    expect(getOrderedIds(result)).toEqual([3, 1, 2]);
  });
});

describe('ReorderHabitsModal — date picker visibility (BUG: picker invisible in edit mode)', () => {
  it('mounts the picker as a sibling of the parent Modal, not a descendant', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));

    // The picker must be reachable from the test renderer's root, and
    // must NOT be a descendant of the modal overlay -- if it were, iOS
    // would animate it underneath the parent and the user would tap an
    // invisible target.
    const reorderList = result.getByTestId('reorder-list');
    const pickerRoot = result.getByTestId('modal-datetime-picker-root');

    const isDescendantOf = (
      node: { children?: ReadonlyArray<unknown> } | null,
      target: object,
    ): boolean => {
      if (!node || !Array.isArray(node.children)) return false;
      for (const child of node.children) {
        if (child === target) return true;
        if (
          typeof child === 'object' &&
          child !== null &&
          isDescendantOf(child as { children?: ReadonlyArray<unknown> }, target)
        ) {
          return true;
        }
      }
      return false;
    };

    // Find a common modal-overlay ancestor by walking up from reorderList.
    // The test verifies the picker is NOT inside that ancestor subtree.
    let modalSubtreeRoot: unknown = reorderList;
    for (let depth = 0; depth < 6 && modalSubtreeRoot; depth += 1) {
      modalSubtreeRoot = (modalSubtreeRoot as { parent?: unknown }).parent ?? null;
    }
    expect(
      isDescendantOf(modalSubtreeRoot as { children?: ReadonlyArray<unknown> }, pickerRoot),
    ).toBe(false);
  });

  it('does not pass a minimumDate so past dates are selectable', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));

    const props = lastModalDatePickerProps.current!;
    expect(props).not.toBeNull();
    expect(props.minimumDate).toBeUndefined();
  });

  it('accepts a confirmed past date and updates the master program start date', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm-past'));

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2020);
    expect(stored.getMonth()).toBe(0);
    expect(stored.getDate()).toBe(1);
  });

  it('mounts the picker only after the user opens it and dismisses cleanly on cancel', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(result.queryByTestId('modal-datetime-confirm')).toBeNull();

    fireEvent.press(result.getByTestId('reorder-start-date'));
    expect(result.getByTestId('modal-datetime-cancel')).toBeTruthy();

    fireEvent.press(result.getByTestId('modal-datetime-cancel'));
    expect(result.queryByTestId('modal-datetime-confirm')).toBeNull();
    expect(getOrderedIds(result)).toEqual([1, 2, 3]);
  });

  it('persists the chosen date, recomputes start_date offsets, and writes the master anchor', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    const data = result.getByTestId('reorder-list').props.data as Habit[];
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(new Date(data[1]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-22');

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2026);
    expect(stored.getMonth()).toBe(5);
    expect(stored.getDate()).toBe(1);
  });
});

describe('ReorderHabitsModal — program-anchor wiring', () => {
  it('seeds the start date from the existing program anchor on open', () => {
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2024, 2, 15)));

    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    // First habit's start_date must match the anchor (March 15, 2024).
    const data = result.getByTestId('reorder-list').props.data as Habit[];
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2024-03-15');
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
