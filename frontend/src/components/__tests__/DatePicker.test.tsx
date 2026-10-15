/* eslint-env jest */
/* global describe, test, expect, jest */

/**
 * Tests for the BUG-FE-UI-107 fix in ``DatePicker``: quick-select
 * buttons disable when their candidate date violates ``minDate``,
 * ``maxDate``, or ``disabledDate``.
 *
 * The previous behaviour fired ``commitDate`` and let validation set
 * an error message, but the picker remained dismissed and the user
 * could not tell whether the action succeeded.  Disabling at the
 * source is the right fix.
 */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import DatePicker from '../DatePicker';

describe('DatePicker quick-select bounds (BUG-FE-UI-107)', () => {
  test('names three separate date buttons and preserves each selected local day', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T12:00:00'));
    try {
      const onChange = jest.fn();
      const { getByRole } = render(<DatePicker value="" onChange={onChange} />);
      for (const [name, expected] of [
        ['Select today', '2026-10-14'],
        ['Select next Monday', '2026-10-19'],
        ['Select first of next month', '2026-11-01'],
      ]) {
        fireEvent.press(getByRole('button', { name }));
        expect(onChange).toHaveBeenLastCalledWith(expected);
      }
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('today button is disabled when minDate is in the future', () => {
    const onChange = jest.fn();
    // Forcing minDate one year ahead ensures "today" is out of range
    // regardless of the host clock.
    const oneYearAhead = new Date();
    oneYearAhead.setFullYear(oneYearAhead.getFullYear() + 1);
    const minDate = oneYearAhead.toISOString().slice(0, 10);

    const { getByLabelText } = render(
      <DatePicker value="" onChange={onChange} minDate={minDate} />,
    );

    const todayButton = getByLabelText('Select today');
    expect(todayButton.props.accessibilityState.disabled).toBe(true);

    // Pressing the disabled button must not fire onChange.  ``fireEvent.press``
    // honours the ``disabled`` prop, so onChange stays untouched.
    fireEvent.press(todayButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('today button is enabled when no bounds restrict it', () => {
    const onChange = jest.fn();
    const { getByLabelText } = render(<DatePicker value="" onChange={onChange} />);

    const todayButton = getByLabelText('Select today');
    expect(todayButton.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(todayButton);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('disabledDate predicate disables matching quick-select buttons', () => {
    const onChange = jest.fn();
    // Block "today" via the disabledDate predicate; "next monday" stays open.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isToday = (d: Date): boolean =>
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();

    const { getByLabelText } = render(
      <DatePicker value="" onChange={onChange} disabledDate={isToday} />,
    );

    const todayButton = getByLabelText('Select today');
    const mondayButton = getByLabelText('Select next Monday');
    expect(todayButton.props.accessibilityState.disabled).toBe(true);
    expect(mondayButton.props.accessibilityState.disabled).toBe(false);
  });
});
