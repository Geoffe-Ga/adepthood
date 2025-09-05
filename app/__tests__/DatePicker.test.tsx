/* eslint-disable import/order */
import { describe, expect, test, jest, beforeAll, afterAll } from '@jest/globals';

import React from 'react';
import renderer, { act } from 'react-test-renderer';

import DatePicker, {
  parseDateInput,
  isDateWithinRange,
  parseISODate,
  toISODate,
} from '../components/DatePicker';

jest.mock('react-native-modal-datetime-picker', () => ({
  __esModule: true,
  default: () => null,
}));

describe('date utilities', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  test('parseDateInput handles various formats', () => {
    expect(parseDateInput('9/1/25')?.toISOString().slice(0, 10)).toBe('2025-09-01');
    expect(parseDateInput('Sep 1 2025')?.toISOString().slice(0, 10)).toBe('2025-09-01');
    expect(parseDateInput('invalid')).toBeNull();
  });

  test('isDateWithinRange validates correctly', () => {
    const min = new Date('2025-01-01');
    const max = new Date('2025-12-31');
    expect(isDateWithinRange(new Date('2025-06-01'), min, max)).toBe(true);
    expect(isDateWithinRange(new Date('2024-12-31'), min, max)).toBe(false);
  });
});

describe('DatePicker component', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2025-06-15'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  test('allows typing and validates range', () => {
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(
        <DatePicker
          value="2025-09-01"
          onChange={handleChange}
          minDate="2025-01-01"
          maxDate="2025-12-31"
        />,
      );
    });
    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onChangeText('2024-12-31');
    });
    const error = tree!.root.findByProps({ accessibilityRole: 'alert' });
    expect(error.props.children).toBe('between 2025-01-01 and 2025-12-31');
    act(() => {
      input.props.onChangeText('2025-10-10');
    });
    expect(handleChange).toHaveBeenLastCalledWith('2025-10-10');
  });

  test('quick action sets today', () => {
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(<DatePicker value="2025-09-01" onChange={handleChange} />);
    });
    const btn = tree!.root.findByProps({ accessibilityLabel: 'Select today' });
    act(() => {
      btn.props.onPress();
    });
    expect(handleChange).toHaveBeenLastCalledWith('2025-06-15');
  });
});

describe('ISO helpers', () => {
  const originalTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    process.env.TZ = originalTZ;
  });

  test('parseISODate preserves local day', () => {
    const d = parseISODate('2025-09-10');
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(10);
    expect(toISODate(d)).toBe('2025-09-10');
  });
});
