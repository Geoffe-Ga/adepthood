/* eslint-env jest */
/* global describe, it, expect, jest */

/**
 * Render tests for the ``ResetConfirmation`` component introduced in
 * PR #302 (BUG-FE-HABIT-202).  The component is the explicit-confirm
 * gate between a calendar pick and the destructive
 * ``onNewStartDate`` call that wipes completions.
 */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// ``react-native-calendars`` ships as ESM; the parent module is only used
// at runtime for the date-picker calendar. This stub records ``onDayPress``
// via a jest.fn passthrough and forwards a fixed day pick through a
// pressable so calendar-driven branches can be exercised without pulling
// in the real native calendar implementation.
jest.mock('react-native-calendars', () => {
  const ReactLib = require('react');
  const RN = require('react-native');
  const Calendar = (props: { onDayPress: (_day: { dateString: string }) => void }) => {
    const handlePress = jest.fn(() => props.onDayPress({ dateString: '2026-08-10' }));
    return ReactLib.createElement(
      RN.TouchableOpacity,
      { testID: 'calendar-mock-day', onPress: handlePress },
      ReactLib.createElement(RN.Text, null, 'calendar-mock'),
    );
  };
  return { Calendar };
});

import * as DatePicker from '../../../../components/DatePicker';
import type { Habit, MissedDaysModalProps } from '../../Habits.types';
import { MissedDaysModal, ResetConfirmation } from '../MissedDaysModal';

describe('ResetConfirmation (BUG-FE-HABIT-202)', () => {
  const pendingDate = new Date(2026, 4, 15); // May 15 2026 in local TZ

  it('renders a warning that names the habit and the chosen date', () => {
    const { getByTestId } = render(
      <ResetConfirmation
        habitName="Morning meditation"
        pendingDate={pendingDate}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    const warning = getByTestId('reset-confirm-warning');
    expect(warning).toHaveTextContent(/Morning meditation/);
    // Date formatting depends on local TZ; just confirm the year appears.
    expect(warning).toHaveTextContent(/2026/);
    expect(warning).toHaveTextContent(/wipes every prior completion/i);
  });

  it('fires onConfirm only when the destructive button is pressed', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <ResetConfirmation
        habitName="X"
        pendingDate={pendingDate}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.press(getByTestId('reset-confirm-yes'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel only when the cancel button is pressed', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <ResetConfirmation
        habitName="X"
        pendingDate={pendingDate}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.press(getByTestId('reset-confirm-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

const baseHabit: Habit = {
  id: 7,
  stage: 'Beige',
  name: 'Journaling',
  icon: '📓',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [],
};

const missedDays = [new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-02T00:00:00.000Z')];

const renderMissedDaysModal = (overrides: Partial<MissedDaysModalProps> = {}) => {
  const onClose = jest.fn();
  const onBackfill = jest.fn();
  const onNewStartDate = jest.fn();
  const utils = render(
    <MissedDaysModal
      visible
      habit={baseHabit}
      missedDays={missedDays}
      onClose={onClose}
      onBackfill={onBackfill}
      onNewStartDate={onNewStartDate}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onBackfill, onNewStartDate };
};

describe('MissedDaysModal visibility guards', () => {
  it('renders nothing when there is no habit', () => {
    const { toJSON } = render(
      <MissedDaysModal
        visible
        habit={null}
        missedDays={missedDays}
        onClose={jest.fn()}
        onBackfill={jest.fn()}
        onNewStartDate={jest.fn()}
      />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when there are no missed days', () => {
    const { toJSON } = renderMissedDaysModal({ missedDays: [] });
    expect(toJSON()).toBeNull();
  });
});

describe('MissedDaysModal message content', () => {
  it('names the habit and pluralizes the missed-day count', () => {
    const { getByText } = renderMissedDaysModal();
    getByText("We missed 2 days for 'Journaling'.");
    getByText("Did you keep up with 'Journaling' while you were gone?");
  });

  it('does not pluralize a single missed day', () => {
    const { getByText } = renderMissedDaysModal({ missedDays: [missedDays[0]!] });
    getByText("We missed 1 day for 'Journaling'.");
  });
});

describe('MissedDaysModal backfill and dismiss actions', () => {
  it('backfills every missed day and closes', () => {
    const { getByText, onBackfill, onClose } = renderMissedDaysModal();
    fireEvent.press(getByText('Yes, I did it!'));
    expect(onBackfill).toHaveBeenCalledWith(7, missedDays);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without backfilling when the user just continues', () => {
    const { getByText, onBackfill, onClose } = renderMissedDaysModal();
    fireEvent.press(getByText('Just continue'));
    expect(onBackfill).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MissedDaysModal guards against a missing habit id', () => {
  it('skips the backfill call when the habit has no id', () => {
    const { getByText, onBackfill, onClose } = renderMissedDaysModal({
      habit: { ...baseHabit, id: 0 },
    });
    fireEvent.press(getByText('Yes, I did it!'));
    expect(onBackfill).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips the start-date reset when the habit has no id', () => {
    const { getByText, getByTestId, onNewStartDate, onClose } = renderMissedDaysModal({
      habit: { ...baseHabit, id: 0 },
    });
    fireEvent.press(getByText('Set new start date'));
    fireEvent.press(getByTestId('calendar-mock-day'));
    fireEvent.press(getByTestId('reset-confirm-yes'));

    expect(onNewStartDate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MissedDaysModal reset-start-date flow', () => {
  it('shows the calendar after choosing to set a new start date', () => {
    const { getByText, getByTestId } = renderMissedDaysModal();
    fireEvent.press(getByText('Set new start date'));
    getByTestId('calendar-mock-day');
  });

  it('holds the picked day for confirmation instead of resetting immediately', () => {
    const { getByText, getByTestId, onNewStartDate } = renderMissedDaysModal();
    fireEvent.press(getByText('Set new start date'));
    fireEvent.press(getByTestId('calendar-mock-day'));

    getByTestId('reset-confirm-warning');
    expect(onNewStartDate).not.toHaveBeenCalled();
  });

  it('returns to the calendar when the pending reset is cancelled', () => {
    const { getByText, getByTestId, queryByTestId } = renderMissedDaysModal();
    fireEvent.press(getByText('Set new start date'));
    fireEvent.press(getByTestId('calendar-mock-day'));

    fireEvent.press(getByTestId('reset-confirm-cancel'));
    expect(queryByTestId('reset-confirm-warning')).toBeNull();
    getByTestId('calendar-mock-day');
  });

  it('resets the start date and closes on confirmation', () => {
    const { getByText, getByTestId, onNewStartDate, onClose } = renderMissedDaysModal();
    fireEvent.press(getByText('Set new start date'));
    fireEvent.press(getByTestId('calendar-mock-day'));

    fireEvent.press(getByTestId('reset-confirm-yes'));
    expect(onNewStartDate).toHaveBeenCalledTimes(1);
    const [habitId, newDate] = onNewStartDate.mock.calls[0] as [number, Date];
    expect(habitId).toBe(7);
    expect(newDate.toISOString().slice(0, 10)).toBe('2026-08-10');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Jest pins TZ=UTC, where `new Date('2026-08-10')` and the tz-safe
  // `parseISODate('2026-08-10')` coincide, so a numeric day assertion cannot
  // distinguish the bug. Instead verify the pick is routed through the
  // tz-safe parser (local midnight) rather than the UTC-parsing `new Date`.
  it('persists the tapped day via the timezone-safe parser, not UTC new Date', () => {
    const spy = jest.spyOn(DatePicker, 'parseISODate');
    try {
      const { getByText, getByTestId, onNewStartDate } = renderMissedDaysModal();
      fireEvent.press(getByText('Set new start date'));
      fireEvent.press(getByTestId('calendar-mock-day'));
      fireEvent.press(getByTestId('reset-confirm-yes'));

      expect(spy).toHaveBeenCalledWith('2026-08-10');
      const [, newDate] = onNewStartDate.mock.calls[0] as [number, Date];
      expect(newDate.getTime()).toBe(DatePicker.parseISODate('2026-08-10').getTime());
    } finally {
      spy.mockRestore();
    }
  });
});
