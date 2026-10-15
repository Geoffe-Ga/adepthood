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

/**
 * Issue #3381: the quick-select candidates used to be memoized once per
 * mount, so a picker left open across local midnight kept offering
 * yesterday as "today" (and a stale "next monday" / "first of next
 * month").  Each candidate must reflect the local calendar day at the
 * moment it is rendered or pressed.
 */
describe('DatePicker quick-select across local calendar transitions (#3381)', () => {
  const withClock = (start: string, body: () => void): void => {
    jest.useFakeTimers().setSystemTime(new Date(start));
    try {
      body();
    } finally {
      jest.useRealTimers();
    }
  };

  test.each([
    ['midnight', '2026-10-14T23:59:00', '2026-10-15T00:01:00', 'Select today', '2026-10-15'],
    ['week', '2026-10-18T23:59:00', '2026-10-19T00:01:00', 'Select next Monday', '2026-10-26'],
    [
      'month',
      '2026-10-31T23:59:00',
      '2026-11-01T00:01:00',
      'Select first of next month',
      '2026-12-01',
    ],
  ])(
    'a still-mounted picker crossing the %s boundary selects the new local day',
    (_boundary, before, after, name, expected) => {
      withClock(before, () => {
        const onChange = jest.fn();
        const { getByRole } = render(<DatePicker value="" onChange={onChange} />);
        jest.setSystemTime(new Date(after));
        fireEvent.press(getByRole('button', { name }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith(expected);
      });
    },
  );

  test('re-rendering after midnight recomputes the disabled state against maxDate', () => {
    withClock('2026-10-14T23:59:00', () => {
      const onChange = jest.fn();
      const { getByLabelText, rerender } = render(
        <DatePicker value="" onChange={onChange} maxDate="2026-10-14" />,
      );
      expect(getByLabelText('Select today').props.accessibilityState.disabled).toBe(false);

      jest.setSystemTime(new Date('2026-10-15T00:01:00'));
      rerender(<DatePicker value="" onChange={onChange} maxDate="2026-10-14" />);

      const todayButton = getByLabelText('Select today');
      expect(todayButton.props.accessibilityState.disabled).toBe(true);
      fireEvent.press(todayButton);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  test('re-rendering after midnight re-enables a candidate that reached minDate', () => {
    withClock('2026-10-14T23:59:00', () => {
      const onChange = jest.fn();
      const { getByLabelText, rerender } = render(
        <DatePicker value="" onChange={onChange} minDate="2026-10-15" />,
      );
      expect(getByLabelText('Select today').props.accessibilityState.disabled).toBe(true);

      jest.setSystemTime(new Date('2026-10-15T00:01:00'));
      rerender(<DatePicker value="" onChange={onChange} minDate="2026-10-15" />);

      const todayButton = getByLabelText('Select today');
      expect(todayButton.props.accessibilityState.disabled).toBe(false);
      fireEvent.press(todayButton);
      expect(onChange).toHaveBeenLastCalledWith('2026-10-15');
    });
  });

  test('pressing a button rendered before midnight never commits an out-of-range new day', () => {
    withClock('2026-10-14T23:59:00', () => {
      const onChange = jest.fn();
      const { getByLabelText, getByRole } = render(
        <DatePicker value="" onChange={onChange} maxDate="2026-10-14" />,
      );
      jest.setSystemTime(new Date('2026-10-15T00:01:00'));
      fireEvent.press(getByLabelText('Select today'));
      expect(onChange).not.toHaveBeenCalled();
      expect(getByRole('alert')).toBeTruthy();
    });
  });

  test('disabledDate sees the new local day once the picker re-renders', () => {
    withClock('2026-10-14T23:59:00', () => {
      const isOct15 = (d: Date): boolean => d.getMonth() === 9 && d.getDate() === 15;
      const onChange = jest.fn();
      const { getByLabelText, rerender } = render(
        <DatePicker value="" onChange={onChange} disabledDate={isOct15} />,
      );
      expect(getByLabelText('Select today').props.accessibilityState.disabled).toBe(false);

      jest.setSystemTime(new Date('2026-10-15T00:01:00'));
      rerender(<DatePicker value="" onChange={onChange} disabledDate={isOct15} />);
      expect(getByLabelText('Select today').props.accessibilityState.disabled).toBe(true);
    });
  });

  test('first of next month is a local midnight, so a maxDate on that day keeps it enabled', () => {
    withClock('2026-10-14T12:00:00', () => {
      const onChange = jest.fn();
      const { getByLabelText } = render(
        <DatePicker value="" onChange={onChange} maxDate="2026-11-01" />,
      );
      const button = getByLabelText('Select first of next month');
      expect(button.props.accessibilityState.disabled).toBe(false);
      fireEvent.press(button);
      expect(onChange).toHaveBeenLastCalledWith('2026-11-01');
    });
  });
});
