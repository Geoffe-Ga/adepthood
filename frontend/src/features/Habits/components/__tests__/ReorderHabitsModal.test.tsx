/* eslint-env jest */
// Regression tests for the three reorder-modal bugs: drag freeze, picker dismissal, and the iOS sibling-mount.
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render, act, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { accent, STAGE_COLORS } from '../../../../design/tokens';
import { useProgramStore } from '../../../../store/useProgramStore';
import { dayKeyInTZ } from '../../../../utils/dateUtils';
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

interface TestHabitEntry {
  kind: 'habit';
  habit: Habit;
}

interface TestPageEntry {
  kind: 'page';
  page: number;
}

type TestReorderEntry = Habit | TestHabitEntry | TestPageEntry;

const getReorderEntries = (list: ReturnType<typeof render>): TestReorderEntry[] =>
  list.getByTestId('reorder-list').props.data as TestReorderEntry[];

const getOrderedHabits = (list: ReturnType<typeof render>): Habit[] =>
  getReorderEntries(list).flatMap((entry) => {
    if ('kind' in entry) return entry.kind === 'habit' ? [entry.habit] : [];
    return [entry];
  });

const getOrderedIds = (list: ReturnType<typeof render>): number[] =>
  getOrderedHabits(list).map((habit) => habit.id);

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

    const afterFirst = getOrderedHabits(result);
    act(() => {
      list.props.onDragEnd({ data: [afterFirst[2], afterFirst[0], afterFirst[1]] });
    });
    expect(getOrderedIds(result)).toEqual([2, 3, 1]);

    const afterSecond = getOrderedHabits(result);
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

describe('ReorderHabitsModal — signed range drop targets', () => {
  const TEN_PROGRAM_HABITS = Array.from({ length: 10 }, (_, index) =>
    makeHabit(index + 1, 'Beige', `Program ${index + 1}`),
  );

  const isPageEntry = (entry: TestReorderEntry, page: number): entry is TestPageEntry =>
    'kind' in entry && entry.kind === 'page' && entry.page === page;

  const isHabitEntry = (entry: TestReorderEntry, id: number): entry is TestHabitEntry =>
    'kind' in entry && entry.kind === 'habit' && entry.habit.id === id;

  it('offers the carryover range and a next-lap target when stages 1–10 are full', () => {
    const result = render(
      <ReorderHabitsModal
        visible
        habits={TEN_PROGRAM_HABITS}
        onClose={jest.fn()}
        onSaveOrder={jest.fn()}
      />,
    );

    expect(result.getByText(/-10 to -1/)).toBeTruthy();
    expect(result.getByText(/11–20/)).toBeTruthy();
  });

  it('turns a program habit into carryover when it crosses the program boundary', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const entries = [...getReorderEntries(result)];
    const movingIndex = entries.findIndex((entry) => isHabitEntry(entry, 3));
    const [moving] = entries.splice(movingIndex, 1);
    const programBoundary = entries.findIndex((entry) => isPageEntry(entry, 0));

    expect(moving).toBeDefined();
    expect(programBoundary).toBeGreaterThanOrEqual(0);
    entries.splice(programBoundary, 0, moving!);
    act(() => result.getByTestId('reorder-list').props.onDragEnd({ data: entries }));

    expect(getOrderedHabits(result).find((habit) => habit.id === 3)?.is_carryover).toBe(true);

    fireEvent.press(result.getByText('Save Order'));
    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    expect(saved.find((habit) => habit.id === 3)?.is_carryover).toBe(true);
  });

  it('turns carryover into stage 11 when it is dropped after ten program habits', () => {
    const carryover = {
      ...makeHabit(99, 'Clear Light', 'Brought along'),
      is_carryover: true,
      start_date: new Date('2025-01-01T00:00:00Z'),
    };
    const result = render(
      <ReorderHabitsModal
        visible
        habits={[carryover, ...TEN_PROGRAM_HABITS]}
        onClose={jest.fn()}
        onSaveOrder={jest.fn()}
      />,
    );
    const entries = [...getReorderEntries(result)];
    const movingIndex = entries.findIndex((entry) => isHabitEntry(entry, 99));
    const [moving] = entries.splice(movingIndex, 1);
    const nextLap = entries.findIndex((entry) => isPageEntry(entry, 1));

    expect(moving).toBeDefined();
    expect(nextLap).toBeGreaterThanOrEqual(0);
    entries.splice(nextLap + 1, 0, moving!);
    act(() => result.getByTestId('reorder-list').props.onDragEnd({ data: entries }));

    const ordered = getOrderedHabits(result);
    expect(ordered.at(-1)?.id).toBe(99);
    expect(ordered.at(-1)?.is_carryover).toBe(false);
    expect(result.getByText(/Brought along \(Beige\)/)).toBeTruthy();
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

  it('accepts a confirmed past date and updates the master program start date on save', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm-past'));
    fireEvent.press(result.getByText('Save Order'));

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2020);
    expect(stored.getMonth()).toBe(0);
    expect(stored.getDate()).toBe(1);
  });

  it('restamps reorder writes on the selected day in the account timezone', async () => {
    const accountZone = 'Pacific/Honolulu';
    const onSaveOrder = jest.fn((_habits: Habit[]) => Promise.resolve());
    const result = render(
      <ReorderHabitsModal
        visible
        habits={HABITS}
        userTimezone={accountZone}
        onClose={jest.fn()}
        onSaveOrder={onSaveOrder}
      />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));
    await act(async () => {
      fireEvent.press(result.getByText('Save Order'));
    });

    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    expect(saved.map((habit) => dayKeyInTZ(habit.start_date, accountZone))).toEqual([
      '2026-06-01',
      '2026-06-22',
      '2026-07-13',
    ]);
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

    const data = getOrderedHabits(result);
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(new Date(data[1]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-22');

    fireEvent.press(result.getByText('Save Order'));

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
    const data = getOrderedHabits(result);
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2024-03-15');
  });

  it('re-syncs the displayed start date to the program anchor after a dismiss and re-open', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    // Anchor changes while open, then the modal is dismissed: the not-visible
    // effect re-seeds startDate from the anchor so the next open reflects it.
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2025, 0, 10)));
    result.rerender(
      <ReorderHabitsModal
        visible={false}
        habits={HABITS}
        onClose={jest.fn()}
        onSaveOrder={jest.fn()}
      />,
    );
    result.rerender(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(result.getByTestId('reorder-start-date')).toHaveTextContent('Jan 10, 2025');
  });
});

describe('ReorderHabitsModal — empty habit list', () => {
  it('seeds no rows when the modal opens with zero habits', () => {
    const result = render(
      <ReorderHabitsModal visible habits={[]} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(getOrderedIds(result)).toEqual([]);
  });
});

describe('ReorderHabitsModal — save flow', () => {
  /** A save whose completion the test controls, standing in for writes on the wire. */
  const heldSave = (): {
    onSave: jest.Mock<(_habits: Habit[]) => Promise<void>>;
    release: () => void;
  } => {
    let release = (): void => {};
    const onSave = jest.fn(
      (_habits: Habit[]) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    return { onSave, release: () => release() };
  };

  it('calls onSaveOrder with the current order and closes once it has landed', async () => {
    const onSave = jest.fn((_habits: Habit[]) => Promise.resolve());
    const onClose = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={onClose} onSaveOrder={onSave} />,
    );

    const list = result.getByTestId('reorder-list');
    act(() => {
      list.props.onDragEnd({ data: [HABITS[1], HABITS[2], HABITS[0]] });
    });

    await act(async () => {
      fireEvent.press(result.getByText('Save Order'));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as Habit[];
    expect(saved.map((h) => h.id)).toEqual([2, 3, 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('holds the modal open and the control busy until the save has settled', async () => {
    // The defect this pins: Save Order used to dismiss the modal the instant
    // the writes were dispatched, so the person was told the reorder was made
    // while every PUT was still in flight -- and backgrounding the app there
    // lost it server-side with local state still claiming it saved.
    const { onSave, release } = heldSave();
    const onClose = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={onClose} onSaveOrder={onSave} />,
    );

    await act(async () => {
      fireEvent.press(result.getByText('Save Order'));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(result.getByTestId('reorder-save-order').props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    expect(result.getByText('Saving…')).toBeTruthy();

    await act(async () => {
      release();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a second Save Order while the first is still on the wire', async () => {
    // One whole-list commit at a time. A second press cannot mean anything new
    // -- it would re-PUT the identical rows -- and it would take its rollback
    // snapshot from a store already holding the optimistic order.
    const { onSave, release } = heldSave();
    const onClose = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={onClose} onSaveOrder={onSave} />,
    );

    await act(async () => {
      fireEvent.press(result.getByTestId('reorder-save-order'));
    });
    await act(async () => {
      fireEvent.press(result.getByTestId('reorder-save-order'));
    });

    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('settles the control and closes even when the save is refused', async () => {
    // A refusal is surfaced and rolled back by the caller; the modal's job is
    // only never to strand the person on a permanent "Saving…".
    const onSave = jest.fn((_habits: Habit[]) => Promise.reject(new Error('offline')));
    const onClose = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={onClose} onSaveOrder={onSave} />,
    );

    await act(async () => {
      fireEvent.press(result.getByText('Save Order'));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.getByText('Save Order')).toBeTruthy();
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

  const webRows = (result: ReturnType<typeof render>) =>
    result.UNSAFE_root.findAll(
      (node: { props: Record<string, unknown> }) => node.props.draggable === true,
    );

  const rangeTarget = (result: ReturnType<typeof render>, page: number) =>
    result.UNSAFE_root.findByProps({ 'data-range-page': page });

  it('uses native draggable rows on web and applies a mouse drop', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const draggableRows = webRows(result);
    let transferredKey = '';
    const dataTransfer = {
      effectAllowed: '',
      setData: jest.fn((_type: string, value: string) => {
        transferredKey = value;
      }),
      getData: jest.fn(() => transferredKey),
    };

    expect(draggableRows).toHaveLength(3);
    act(() => draggableRows[0]!.props.onDragStart({ dataTransfer }));
    act(() =>
      draggableRows[2]!.props.onDrop({
        preventDefault: jest.fn(),
        dataTransfer,
      }),
    );

    fireEvent.press(result.getByText('Save Order'));
    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    expect(saved.map((habit) => habit.id)).toEqual([2, 3, 1]);
  });

  it('uses the drag payload when pointer-up clears transient state before drop', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    let transferredKey = '';
    const dataTransfer = {
      effectAllowed: '',
      setData: jest.fn((_type: string, value: string) => {
        transferredKey = value;
      }),
      getData: jest.fn(() => transferredKey),
    };

    act(() => webRows(result)[0]!.props.onDragStart({ dataTransfer }));
    act(() =>
      result.UNSAFE_root.findByProps({ 'data-testid': 'reorder-list' }).props.onPointerUp(),
    );
    act(() => rangeTarget(result, -1).props.onDrop({ preventDefault: jest.fn(), dataTransfer }));
    fireEvent.press(result.getByText('Save Order'));

    const moved = (onSaveOrder.mock.calls[0]![0] as Habit[]).find((habit) => habit.id === 1)!;
    expect(dataTransfer.getData).toHaveBeenCalledWith('text/plain');
    expect(moved.is_carryover).toBe(true);
  });

  it('falls back to pointer dragging when the browser does not emit HTML drop events', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const draggableRows = webRows(result);

    act(() => draggableRows[0]!.props.onPointerDown());
    act(() => draggableRows[2]!.props.onPointerUp());

    fireEvent.press(result.getByText('Save Order'));
    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    expect(saved.map((habit) => habit.id)).toEqual([2, 3, 1]);
  });

  it('clears an abandoned pointer drag so a later pointer-up cannot reorder', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const draggableRows = webRows(result);

    act(() => draggableRows[0]!.props.onPointerDown());
    expect(draggableRows[0]!.props.style.opacity).toBe(0.55);
    act(() =>
      result.UNSAFE_root.findByProps({ 'data-testid': 'reorder-list' }).props.onPointerCancel(),
    );

    const rowsAfterCancel = webRows(result);
    expect(rowsAfterCancel[0]!.props.style.opacity).toBe(1);
    act(() => rowsAfterCancel[2]!.props.onPointerUp());

    fireEvent.press(result.getByText('Save Order'));
    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    expect(saved.map((habit) => habit.id)).toEqual([1, 2, 3]);
  });

  it('drops a program habit onto the negative marker and preserves its date as carryover', () => {
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 0, 1)));
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const dataTransfer = {
      effectAllowed: '',
      setData: jest.fn(),
      getData: jest.fn(() => 'habit:3'),
    };

    act(() => webRows(result)[2]!.props.onDragStart({ dataTransfer }));
    act(() => rangeTarget(result, -1).props.onDrop({ preventDefault: jest.fn(), dataTransfer }));
    fireEvent.press(result.getByText('Save Order'));

    const moved = (onSaveOrder.mock.calls[0]![0] as Habit[]).find((habit) => habit.id === 3)!;
    expect(moved.is_carryover).toBe(true);
    expect(new Date(moved.start_date).toISOString().slice(0, 10)).toBe('2026-02-12');
  });

  it('drops carryover onto the program marker and recomputes its program date', () => {
    const carryover = {
      ...makeHabit(99, 'Clear Light', 'Brought along'),
      is_carryover: true,
      start_date: new Date('2025-01-01T00:00:00Z'),
    };
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 0, 1)));
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal
        visible
        habits={[carryover, ...HABITS]}
        onClose={jest.fn()}
        onSaveOrder={onSaveOrder}
      />,
    );
    const dataTransfer = {
      effectAllowed: '',
      setData: jest.fn(),
      getData: jest.fn(() => 'habit:99'),
    };

    act(() => webRows(result)[0]!.props.onDragStart({ dataTransfer }));
    act(() => rangeTarget(result, 0).props.onDrop({ preventDefault: jest.fn(), dataTransfer }));
    fireEvent.press(result.getByText('Save Order'));

    const moved = (onSaveOrder.mock.calls[0]![0] as Habit[]).find((habit) => habit.id === 99)!;
    expect(moved.is_carryover).toBe(false);
    expect(new Date(moved.start_date).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('drops carryover onto the 11–20 marker after ten program habits', () => {
    const carryover = {
      ...makeHabit(99, 'Clear Light', 'Brought along'),
      is_carryover: true,
      start_date: new Date('2025-01-01T00:00:00Z'),
    };
    const program = Array.from({ length: 10 }, (_, index) =>
      makeHabit(index + 1, 'Beige', `Program ${index + 1}`),
    );
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 0, 1)));
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal
        visible
        habits={[carryover, ...program]}
        onClose={jest.fn()}
        onSaveOrder={onSaveOrder}
      />,
    );
    const dataTransfer = {
      effectAllowed: '',
      setData: jest.fn(),
      getData: jest.fn(() => 'habit:99'),
    };

    act(() => webRows(result)[0]!.props.onDragStart({ dataTransfer }));
    act(() => rangeTarget(result, 1).props.onDrop({ preventDefault: jest.fn(), dataTransfer }));
    fireEvent.press(result.getByText('Save Order'));

    const saved = onSaveOrder.mock.calls[0]![0] as Habit[];
    const moved = saved.find((habit) => habit.id === 99)!;
    expect(saved.at(-1)?.id).toBe(99);
    expect(moved.is_carryover).toBe(false);
    expect(new Date(moved.start_date).getTime()).toBeGreaterThan(
      new Date(saved.at(-2)!.start_date).getTime(),
    );
  });

  it('supports keyboard moves across a range boundary', () => {
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );
    const preventDefault = jest.fn();

    expect(webRows(result)[0]!.props.tabIndex).toBe(0);
    expect(webRows(result)[0]!.props.role).toBe('listitem');
    expect(webRows(result)[0]!.props['aria-keyshortcuts']).toBe('ArrowUp ArrowDown');
    act(() => webRows(result)[0]!.props.onKeyDown({ key: 'ArrowUp', preventDefault }));
    fireEvent.press(result.getByText('Save Order'));

    const moved = (onSaveOrder.mock.calls[0]![0] as Habit[]).find((habit) => habit.id === 1)!;
    expect(preventDefault).toHaveBeenCalled();
    expect(moved.is_carryover).toBe(true);
  });

  it('scrolls the bounded list while a browser drag approaches either edge', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );
    const draggableRows = webRows(result);
    const scrollSurface = result.UNSAFE_root.findByProps({ 'data-testid': 'reorder-list' });
    const currentTarget = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    };

    act(() =>
      draggableRows[0]!.props.onDragStart({
        dataTransfer: { effectAllowed: '', setData: jest.fn() },
      }),
    );
    act(() =>
      scrollSurface.props.onDragOver({
        clientY: 490,
        currentTarget,
        preventDefault: jest.fn(),
      }),
    );

    expect(currentTarget.scrollTop).toBeGreaterThan(100);
  });

  it('renders an HTML date input on web that updates the master program anchor on save', () => {
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const input = result.UNSAFE_root.findByProps({ type: 'date' });
    expect(input).toBeTruthy();
    expect(input.props['aria-label']).toBe('First habit start date');

    act(() => {
      input.props.onChange({ target: { value: '2026-09-01' } });
    });
    fireEvent.press(result.getByText('Save Order'));

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2026);
    expect(stored.getMonth()).toBe(8);
    expect(stored.getDate()).toBe(1);
  });

  it('ignores an empty web date-input change and leaves the anchor where it was', () => {
    // Clearing the field yields ''. ``parseISODate('')`` is not Invalid Date --
    // Number('') is 0, so it returns new Date(0, 0, 1), i.e. 1900-01-01, a
    // perfectly valid date that would restamp every program row and then be
    // persisted by Save Order. The guard is what stops that, so this drives the
    // whole commit path and pins the date rather than merely asserting the
    // anchor is falsy: a null assertion here passes whether or not the guard
    // exists, because nothing before Save Order writes the anchor at all.
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 2, 10)));
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    const input = result.UNSAFE_root.findByProps({ type: 'date' });
    act(() => {
      input.props.onChange({ target: { value: '' } });
    });
    fireEvent.press(result.getByText('Save Order'));

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.toISOString().slice(0, 10)).toBe('2026-03-10');
  });
});

describe('ReorderHabitsModal — the program cadence is laid over program habits only', () => {
  // The modal restamps every row it is handed by list index. HabitsScreen hands
  // it the full mixed list, so a carryover habit sitting at index 0 used to
  // swallow the program's own first date and push every program habit one stage
  // later. That corrupts two things at once: the carryover row loses the date
  // the user actually started it, and the program's first habit no longer sits
  // on the day the user picked.
  const CARRYOVER_START = new Date(2026, 0, 15);
  const PICKED = new Date(2026, 5, 1);
  const FIRST_STAGE_DAYS = 21;

  const carryoverHabit: Habit = {
    ...makeHabit(10, 'Beige', 'Morning pages'),
    start_date: CARRYOVER_START,
    is_carryover: true,
  };
  const MIXED: Habit[] = [carryoverHabit, makeHabit(1, 'Beige', 'A'), makeHabit(2, 'Purple', 'B')];

  const dayOf = (habit: Habit): string => new Date(habit.start_date).toISOString().slice(0, 10);

  const openWith = (habits: Habit[]) => {
    act(() => useProgramStore.getState().hydrateProgramStartDate(PICKED));
    return render(
      <ReorderHabitsModal visible habits={habits} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );
  };

  it('leaves a carryover habit on the date the user actually started it', () => {
    const result = openWith(MIXED);

    const data = getOrderedHabits(result);
    const carryover = data.find((h) => h.id === 10)!;

    expect(dayOf(carryover)).toBe('2026-01-15');
  });

  it('starts the first program habit on the picked date even behind a carryover habit', () => {
    const result = openWith(MIXED);

    const data = getOrderedHabits(result);
    const firstProgram = data.find((h) => h.id === 1)!;
    const secondProgram = data.find((h) => h.id === 2)!;

    expect(dayOf(firstProgram)).toBe('2026-06-01');
    expect(dayOf(secondProgram)).toBe('2026-06-22');
  });

  it('indexes the program cadence by program position, not by row position', () => {
    // Two carryover rows ahead of the program rows would have pushed the first
    // program habit two stages out. The cadence must not count them at all.
    const twoCarryover: Habit[] = [
      carryoverHabit,
      {
        ...makeHabit(11, 'Beige', 'Evening walk'),
        start_date: CARRYOVER_START,
        is_carryover: true,
      },
      makeHabit(1, 'Beige', 'A'),
      makeHabit(2, 'Purple', 'B'),
    ];

    const result = openWith(twoCarryover);

    const data = getOrderedHabits(result);
    const gapDays =
      (new Date(data.find((h) => h.id === 2)!.start_date).getTime() -
        new Date(data.find((h) => h.id === 1)!.start_date).getTime()) /
      (24 * 60 * 60 * 1000);

    expect(dayOf(data.find((h) => h.id === 1)!)).toBe('2026-06-01');
    expect(gapDays).toBe(FIRST_STAGE_DAYS);
  });

  it('keeps a dragged reorder from restamping carryover rows either', () => {
    const result = openWith(MIXED);

    act(() => {
      result
        .getByTestId('reorder-list')
        .props.onDragEnd({ data: [MIXED[1], carryoverHabit, MIXED[2]] });
    });

    const data = getOrderedHabits(result);

    expect(dayOf(data.find((h) => h.id === 10)!)).toBe('2026-01-15');
    expect(dayOf(data.find((h) => h.id === 1)!)).toBe('2026-06-01');
    expect(dayOf(data.find((h) => h.id === 2)!)).toBe('2026-06-22');
  });
});

describe('ReorderHabitsModal — the anchor commits when the order commits', () => {
  // The picker used to write the global anchor the instant it confirmed, while
  // the restamped rows waited for Save Order. Previewing a date and then
  // dismissing therefore left every other screen computing from a date the
  // user had rejected, with no row on disk agreeing with it.
  const CARRYOVER_START = new Date(2026, 0, 15);
  const STORED_PICK = new Date(2026, 2, 10);

  const carryoverHabit: Habit = {
    ...makeHabit(10, 'Beige', 'Morning pages'),
    start_date: CARRYOVER_START,
    is_carryover: true,
  };

  const storedDay = (): string => {
    const stored = useProgramStore.getState().programStartDate;
    return stored === null ? 'none' : new Date(stored).toISOString().slice(0, 10);
  };

  it('leaves the anchor alone when a previewed date is abandoned without saving', () => {
    act(() => useProgramStore.getState().hydrateProgramStartDate(STORED_PICK));
    const onSaveOrder = jest.fn();
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={onSaveOrder} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    expect(onSaveOrder).not.toHaveBeenCalled();
    expect(storedDay()).toBe('2026-03-10');
  });

  it('previews the abandoned date on the rows even though the anchor is untouched', () => {
    // The preview is the affordance, and it must keep working -- what changes
    // is only that nothing leaves the modal until the user commits.
    act(() => useProgramStore.getState().hydrateProgramStartDate(STORED_PICK));
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));

    const data = getOrderedHabits(result);
    expect(new Date(data[0]!.start_date).toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(storedDay()).toBe('2026-03-10');
  });

  it('writes the anchor once the user commits the order', () => {
    act(() => useProgramStore.getState().hydrateProgramStartDate(STORED_PICK));
    const result = render(
      <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    fireEvent.press(result.getByTestId('reorder-start-date'));
    fireEvent.press(result.getByTestId('modal-datetime-confirm'));
    fireEvent.press(result.getByText('Save Order'));

    expect(storedDay()).toBe('2026-06-01');
  });

  it('labels each row with the stage its own date belongs to', () => {
    // The date is stamped by position among program habits; the stage label
    // must be read off the same position, or a row announces a stage that
    // contradicts the date printed beside it.
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 5, 1)));
    const mixed: Habit[] = [
      carryoverHabit,
      makeHabit(1, 'Beige', 'A'),
      makeHabit(2, 'Purple', 'B'),
    ];
    const result = render(
      <ReorderHabitsModal visible habits={mixed} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    // A holds the picked date, so A is the program's Beige habit.
    expect(result.getByText(/A \(Beige\)/)).toBeTruthy();
    expect(result.getByText(/B \(Purple\)/)).toBeTruthy();
    // The brought-along row takes a mirrored negative slot, as it does everywhere else.
    expect(result.getByText(/Morning pages \(Clear Light\)/)).toBeTruthy();
  });

  it('paints a negative-slot row with the carryover accent and keeps program colors', () => {
    const mixed: Habit[] = [carryoverHabit, makeHabit(1, 'Beige', 'A')];
    const result = render(
      <ReorderHabitsModal visible habits={mixed} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
    );

    expect(
      StyleSheet.flatten(result.getByTestId('reorder-habit-10').props.style).borderLeftColor,
    ).toBe(accent.primary);
    expect(
      StyleSheet.flatten(result.getByTestId('reorder-habit-1').props.style).borderLeftColor,
    ).toBe(STAGE_COLORS.Beige);
  });
});
