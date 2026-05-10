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
// at runtime for the date-picker calendar so a stub is fine for the
// ``ResetConfirmation``-only render tests.
jest.mock('react-native-calendars', () => ({
  Calendar: () => null,
}));

import { ResetConfirmation } from '../MissedDaysModal';

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
