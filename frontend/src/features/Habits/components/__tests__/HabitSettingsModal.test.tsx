import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Switch } from 'react-native';

import type { Habit, HabitSettingsModalProps } from '../../Habits.types';
import { HabitSettingsModal } from '../HabitSettingsModal';

jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ onBegin: () => ({}) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));

const baseHabit: Habit = {
  id: 42,
  stage: 'Beige',
  name: 'Morning walk',
  icon: '🚶',
  streak: 3,
  energy_cost: 3,
  energy_return: 5,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [],
  notificationFrequency: 'daily',
  notificationTimes: [],
  notificationDays: [],
  milestoneNotifications: false,
};

const renderModal = (overrides: Partial<HabitSettingsModalProps> = {}) => {
  const onClose = jest.fn();
  const onUpdate = jest.fn();
  const onDelete = jest.fn();
  const onOpenReorderModal = jest.fn();
  const utils = render(
    <HabitSettingsModal
      visible
      habit={baseHabit}
      onClose={onClose}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onOpenReorderModal={onOpenReorderModal}
      allHabits={[baseHabit]}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onUpdate, onDelete, onOpenReorderModal };
};

describe('HabitSettingsModal visibility', () => {
  it('renders nothing when there is no habit to edit', () => {
    const { toJSON } = render(
      <HabitSettingsModal
        visible
        habit={null}
        onClose={jest.fn()}
        onUpdate={jest.fn()}
        onDelete={jest.fn()}
        onOpenReorderModal={jest.fn()}
        allHabits={[]}
      />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders the header, basic fields, and computed net energy', () => {
    const { getByText, getByDisplayValue } = renderModal();
    getByText('Edit Habit');
    getByDisplayValue('Morning walk');
    getByText('🚶');
    getByText('Beige');
    getByText('2');
  });
});

describe('HabitSettingsModal name and icon editing', () => {
  it('updates the controlled name input as the user types', () => {
    const { getByDisplayValue } = renderModal();
    const nameInput = getByDisplayValue('Morning walk');
    fireEvent.changeText(nameInput, 'Evening walk');
    getByDisplayValue('Evening walk');
  });

  it('selecting an emoji updates the icon and closes the selector', () => {
    const { getByText, getByTestId, queryByTestId } = renderModal();
    fireEvent.press(getByText('🚶'));

    getByTestId('emoji-picker');
    fireEvent.press(getByTestId('emoji-picker-select'));

    getByText('\u{1F389}');
    expect(queryByTestId('emoji-picker')).toBeNull();
  });
});

describe('HabitSettingsModal energy inputs', () => {
  it('recalculates net energy when the cost input commits a new value', () => {
    const { getByDisplayValue, getByText } = renderModal();
    const costInput = getByDisplayValue('3');
    fireEvent.changeText(costInput, '7');
    getByText('-2');
  });

  it('reverts to the last committed value when the return field blurs on invalid input', () => {
    const { getByDisplayValue, getByText } = renderModal();
    const returnInput = getByDisplayValue('5');
    fireEvent.changeText(returnInput, 'abc');
    fireEvent(returnInput, 'blur');
    getByDisplayValue('5');
    getByText('2');
  });
});

describe('HabitSettingsModal notification frequency', () => {
  it('cycles daily to weekly to custom and back to daily', () => {
    const { getByText } = renderModal({
      habit: { ...baseHabit, notificationFrequency: undefined },
    });
    const frequencyButton = getByText('daily');

    fireEvent.press(frequencyButton);
    getByText('daily');

    fireEvent.press(getByText('daily'));
    getByText('weekly');

    fireEvent.press(getByText('weekly'));
    getByText('custom');

    fireEvent.press(getByText('custom'));
    getByText('daily');
  });

  it('reveals the day-picker grid and updates the days summary when a day is toggled', () => {
    const { getByText, getAllByText, queryByText } = renderModal({
      habit: { ...baseHabit, notificationFrequency: 'custom', notificationDays: [] },
    });
    getByText('Select days');

    fireEvent.press(getByText('Select days'));
    const mondayGridOption = getByText('Mon');
    fireEvent.press(mondayGridOption);

    expect(queryByText('Select days')).toBeNull();
    expect(getAllByText('Mon')).toHaveLength(2);
  });

  it('deselects a day via the grid, returning the summary label to the default', () => {
    const { getByText, getAllByText } = renderModal({
      habit: { ...baseHabit, notificationFrequency: 'custom', notificationDays: ['Monday'] },
    });
    getByText('Mon');

    fireEvent.press(getByText('Mon'));
    const gridMonday = getAllByText('Mon')[1]!;
    fireEvent.press(gridMonday);

    expect(getAllByText('Mon')).toHaveLength(1);
    getByText('Select days');
  });
});

describe('HabitSettingsModal notification and milestone toggles', () => {
  it('turns notifications off and hides frequency controls, then back on', () => {
    const { getByText, queryByText, UNSAFE_root } = renderModal();
    const notifSwitch = UNSAFE_root.findAllByType(Switch)[0]!;

    fireEvent(notifSwitch, 'valueChange', false);
    expect(queryByText('Frequency:')).toBeNull();

    fireEvent(notifSwitch, 'valueChange', true);
    getByText('Frequency:');
  });

  it('toggles milestone notifications independently', () => {
    const { onUpdate, UNSAFE_root, getByText } = renderModal();
    const milestoneSwitch = UNSAFE_root.findAllByType(Switch)[1]!;

    fireEvent(milestoneSwitch, 'valueChange', true);
    fireEvent.press(getByText('Save Changes'));

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ milestoneNotifications: true }),
    );
  });
});

describe('HabitSettingsModal notification times', () => {
  it('adds a picked time and ignores a duplicate add', () => {
    const { getByText, onUpdate, UNSAFE_root } = renderModal();

    fireEvent.press(getByText('08:00'));
    const timePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'time',
    )!;
    fireEvent(timePicker, 'onChange', {}, new Date(2024, 0, 1, 9, 5));

    fireEvent.press(getByText('+'));
    fireEvent.press(getByText('+'));

    fireEvent.press(getByText('Save Changes'));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ notificationTimes: ['09:05'] }),
    );
  });

  it('removes an added notification time before saving', () => {
    const { getByText, getAllByText, onUpdate, UNSAFE_root } = renderModal();

    fireEvent.press(getByText('08:00'));
    const timePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'time',
    )!;
    fireEvent(timePicker, 'onChange', {}, new Date(2024, 0, 1, 9, 5));
    fireEvent.press(getByText('+'));

    const removeButtons = getAllByText('×');
    fireEvent.press(removeButtons[removeButtons.length - 1]!);

    fireEvent.press(getByText('Save Changes'));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ notificationTimes: [] }));
  });
});

describe('HabitSettingsModal start date', () => {
  it('ignores a change event without a selected date', () => {
    const { UNSAFE_root, onUpdate, getByText } = renderModal();
    const datePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'date',
    )!;

    fireEvent(datePicker, 'onChange', {}, undefined);
    fireEvent.press(getByText('Save Changes'));

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: baseHabit.start_date }),
    );
  });

  it('commits a newly picked start date on save', () => {
    const { UNSAFE_root, onUpdate, getByText } = renderModal();
    const datePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'date',
    )!;
    const newDate = new Date('2026-03-01T00:00:00.000Z');

    fireEvent(datePicker, 'onChange', {}, newDate);
    fireEvent.press(getByText('Save Changes'));

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ start_date: newDate }));
  });
});

describe('HabitSettingsModal time picker platform behavior', () => {
  const Platform = require('react-native').Platform as { OS: string };
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'android';
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('collapses the time picker immediately after a pick on non-iOS platforms', () => {
    const { getByText, UNSAFE_root } = renderModal();
    fireEvent.press(getByText('08:00'));
    const timePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'time',
    )!;
    fireEvent(timePicker, 'onChange', {}, new Date(2024, 0, 1, 10, 30));

    getByText('10:30');
    const remaining = UNSAFE_root.findAllByType('DateTimePicker').filter(
      (node: { props: { mode?: string } }) => node.props.mode === 'time',
    );
    expect(remaining).toHaveLength(0);
  });
});

describe('HabitSettingsModal missing optional notification arrays', () => {
  it('adds a time when the habit has no existing notificationTimes array', () => {
    const { getByText, onUpdate, UNSAFE_root } = renderModal({
      habit: { ...baseHabit, notificationTimes: undefined },
    });

    fireEvent.press(getByText('08:00'));
    const timePicker = UNSAFE_root.findAllByType('DateTimePicker').find(
      (node: { props: { mode?: string } }) => node.props.mode === 'time',
    )!;
    fireEvent(timePicker, 'onChange', {}, new Date(2024, 0, 1, 9, 5));
    fireEvent.press(getByText('+'));

    fireEvent.press(getByText('Save Changes'));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ notificationTimes: ['09:05'] }),
    );
  });

  it('toggles a day when the habit has no existing notificationDays array', () => {
    const { getByText, onUpdate } = renderModal({
      habit: { ...baseHabit, notificationFrequency: 'custom', notificationDays: undefined },
    });

    fireEvent.press(getByText('Select days'));
    fireEvent.press(getByText('Mon'));
    fireEvent.press(getByText('Save Changes'));

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ notificationDays: ['Monday'] }),
    );
  });
});

describe('HabitSettingsModal actions', () => {
  it('opens the reorder modal with the full habit list', () => {
    const { getByText, onOpenReorderModal } = renderModal();
    fireEvent.press(getByText('Reorder Habits'));
    expect(onOpenReorderModal).toHaveBeenCalledWith([baseHabit]);
  });

  it('saves the edited habit and closes', () => {
    const { getByDisplayValue, getByText, onUpdate, onClose } = renderModal();
    fireEvent.changeText(getByDisplayValue('Morning walk'), 'Evening walk');
    fireEvent.press(getByText('Save Changes'));

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, name: 'Evening walk' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the header close button without saving', () => {
    const { getAllByText, onClose, onUpdate } = renderModal();
    fireEvent.press(getAllByText('×')[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('cancels a delete via the confirmation dialog', () => {
    const { getByText, getByTestId, onDelete, onClose } = renderModal();
    fireEvent.press(getByText('Delete Habit'));
    getByTestId('delete-habit-confirm');

    fireEvent.press(getByTestId('delete-habit-cancel'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('confirms a delete, calling onDelete then onClose', () => {
    const { getByText, getByTestId, onDelete, onClose } = renderModal();
    fireEvent.press(getByText('Delete Habit'));

    fireEvent.press(getByTestId('delete-habit-confirm-button'));
    expect(onDelete).toHaveBeenCalledWith(42);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('skips saving when the habit has no id', () => {
    const { getByText, onUpdate, onClose } = renderModal({ habit: { ...baseHabit, id: 0 } });
    fireEvent.press(getByText('Save Changes'));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips opening the delete confirmation when the habit has no id', () => {
    const { getByText, queryByTestId } = renderModal({ habit: { ...baseHabit, id: 0 } });
    fireEvent.press(getByText('Delete Habit'));
    expect(queryByTestId('delete-habit-confirm')).toBeNull();
  });
});
