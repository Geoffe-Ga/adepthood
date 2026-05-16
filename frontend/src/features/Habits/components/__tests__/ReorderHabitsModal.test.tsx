/* eslint-env jest */
// Regression tests for the three reorder-modal bugs: drag freeze, picker dismissal, and the iOS sibling-mount.
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render, act, within } from '@testing-library/react-native';
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

// Captured picker props so structural / prop tests can introspect them.
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

    // Anchor the assertion to the modal overlay's testID; nesting the
    // picker inside this subtree is exactly the iOS bug we're guarding
    // against.  ``within(...).queryByTestId`` returns null when the
    // descendant isn't present, which is the passing condition.
    const overlay = result.getByTestId('reorder-modal-overlay');
    expect(within(overlay).queryByTestId('modal-datetime-picker-root')).toBeNull();
    // Sanity-check the picker actually mounted somewhere reachable.
    expect(result.getByTestId('modal-datetime-picker-root')).toBeTruthy();
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

  it('clears pickerVisible when the parent modal closes (e.g. Android back button)', () => {
    // Reviewer #2 blocker: ``onRequestClose`` (Android back) bypasses
    // both ``handleCancelDate`` and ``handleConfirmDate``, so without an
    // explicit reset the picker would spring back open on re-render
    // even though the user never tapped the start-date button.
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    expect(result.getByTestId('modal-datetime-cancel')).toBeTruthy();

    // Parent modal closes via the system back button -- no handler runs
    // inside the picker's own confirm/cancel paths.
    result.rerender(
      <ReorderHabitsModal
        visible={false}
        habits={HABITS}
        onClose={jest.fn()}
        onSaveOrder={jest.fn()}
      />,
    );

    // Re-open the parent modal.  The picker must NOT re-mount on its
    // own; only an explicit start-date tap should bring it back.
    result.rerender(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );
    expect(result.queryByTestId('modal-datetime-cancel')).toBeNull();
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

describe('ReorderHabitsModal — stage is derived from list position, not stored field', () => {
  it('labels the parentheses by list position, ignoring item.stage', () => {
    // Stored stages deliberately disagree with positional order.
    const habits: Habit[] = [
      makeHabit(1, 'Yellow', 'first'),
      makeHabit(2, '', 'second'),
      makeHabit(3, 'Clear Light', 'third'),
    ];

    const result = render(
      <ReorderHabitsModal visible habits={habits} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(result.queryByText('⭐ first (Beige)')).toBeTruthy();
    expect(result.queryByText('⭐ second (Purple)')).toBeTruthy();
    expect(result.queryByText('⭐ third (Red)')).toBeTruthy();
  });

  it('does not re-sort by item.stage on open — uses the order the parent passed in', () => {
    const habits: Habit[] = [
      makeHabit(7, 'Yellow', 'skincare'), // stored 7th-color, but listed first
      makeHabit(1, 'Beige', 'journal'),
      makeHabit(2, 'Purple', 'fitness'),
    ];

    const result = render(
      <ReorderHabitsModal visible habits={habits} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(getOrderedIds(result)).toEqual([7, 1, 2]);
  });

  it('updates stage labels live as the user drags rows into new positions', () => {
    const habits: Habit[] = [
      makeHabit(1, 'Beige', 'a'),
      makeHabit(2, 'Purple', 'b'),
      makeHabit(3, 'Red', 'c'),
    ];

    const result = render(
      <ReorderHabitsModal visible habits={habits} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const list = result.getByTestId('reorder-list');
    act(() => {
      list.props.onDragEnd({ data: [habits[2], habits[0], habits[1]] });
    });

    expect(result.queryByText('⭐ c (Beige)')).toBeTruthy();
    expect(result.queryByText('⭐ a (Purple)')).toBeTruthy();
    expect(result.queryByText('⭐ b (Red)')).toBeTruthy();
  });
});

describe('ReorderHabitsModal — date picker on web', () => {
  const Platform = require('react-native').Platform as { OS: string };
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('renders an HTML date input on web that updates the master program anchor', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const input = result.UNSAFE_root.findByProps({ type: 'date' });
    expect(input).toBeTruthy();
    expect(input.props['aria-label']).toBe('First habit start date');

    act(() => {
      input.props.onChange({ target: { value: '2026-09-01' } });
    });

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2026);
    expect(stored.getMonth()).toBe(8);
    expect(stored.getDate()).toBe(1);
  });
});
