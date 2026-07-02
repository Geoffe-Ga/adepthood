/* eslint-disable import/order */
import {
  describe,
  expect,
  test,
  jest,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';

import React from 'react';
import { Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';

import DatePicker, {
  parseDateInput,
  isDateWithinRange,
  parseISODate,
  toISODate,
  getNextMonday,
} from '../src/components/DatePicker';

const mockDateTimePickerModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock('react-native-modal-datetime-picker', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockDateTimePickerModal(props),
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

  test('parseDateInput fills in the current year for a bare M/D with no year', () => {
    // System time here is faked to 2025-01-01, so a year-less M/D resolves against it.
    expect(parseDateInput('9/1')?.toISOString().slice(0, 10)).toBe('2025-09-01');
  });

  test('parseDateInput keeps an explicit 4-digit M/D/YYYY year as-is', () => {
    expect(parseDateInput('9/1/2025')?.toISOString().slice(0, 10)).toBe('2025-09-01');
  });

  test('parseDateInput returns null for a blank/whitespace-only string', () => {
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('   ')).toBeNull();
  });

  test('a "Word Day" whose word is not a real month falls through to the loose Date fallback', () => {
    // parseMonthDay rejects it (Date.parse of the reconstructed string is NaN),
    // so it reaches the permissive `new Date()` fallback, which treats the number
    // as a month rather than returning null.
    const parsed = parseDateInput('Nope 10');
    expect(parsed).not.toBeNull();
    expect(parsed!.getUTCMonth()).toBe(9);
  });

  test('parseDateInput preserves local day for ISO input', () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    jest.isolateModules(() => {
      const {
        parseDateInput: parseInput,
        toISODate: toISO,
      } = require('../src/components/DatePicker');
      const parsed = parseInput('2025-09-10');
      expect(parsed).not.toBeNull();
      expect(toISO(parsed!)).toBe('2025-09-10');
    });
    process.env.TZ = originalTZ;
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
    jest.useFakeTimers().setSystemTime(new Date('2025-06-15T12:00:00'));
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
    expect(error.props.children).toBe('Pick a date between 2025-01-01 and 2025-12-31.');
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

  test('typing a bare "Month Day" (no year) parses via the current year', () => {
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(<DatePicker value="" onChange={handleChange} />);
    });
    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onChangeText('Aug 5');
    });
    expect(handleChange).toHaveBeenLastCalledWith('2025-08-05');
  });

  test('rolls an ISO-shaped date that fails the strict round-trip through the loose fallback', () => {
    // '2025-02-30' fails the strict parseISO round-trip guard (Feb has no 30th),
    // so it flows to the permissive `new Date()` fallback, which rolls it to Mar 2.
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(<DatePicker value="" onChange={handleChange} />);
    });
    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onChangeText('2025-02-30');
    });
    expect(tree!.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    expect(handleChange).toHaveBeenLastCalledWith('2025-03-02');
  });

  test('typing unparseable text shows the format-hint error', () => {
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(<DatePicker value="" onChange={handleChange} />);
    });
    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onChangeText('not a date at all');
    });
    const error = tree!.root.findByProps({ accessibilityRole: 'alert' });
    expect(error.props.children).toBe('Use the format YYYY-MM-DD (for example, 2026-04-13).');
    expect(handleChange).not.toHaveBeenCalled();
  });

  test('typing a date blocked by disabledDate shows the unavailable-day message', () => {
    const handleChange = jest.fn();
    const blockJuly4 = (d: Date): boolean =>
      d.getFullYear() === 2025 && d.getMonth() === 6 && d.getDate() === 4;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(
        <DatePicker value="" onChange={handleChange} disabledDate={blockJuly4} />,
      );
    });
    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onChangeText('2025-07-04');
    });
    const error = tree!.root.findByProps({ accessibilityRole: 'alert' });
    expect(error.props.children).toBe("That day isn't available — choose another.");
    expect(handleChange).not.toHaveBeenCalled();
  });

  test('native picker onConfirm commits the picked date and hides the modal', () => {
    const handleChange = jest.fn();
    act(() => {
      renderer.create(<DatePicker value="" onChange={handleChange} />);
    });

    const props = mockDateTimePickerModal.mock.calls.at(-1)?.[0] as {
      isVisible: boolean;
      onConfirm: (_d: Date) => void;
    };
    expect(props.isVisible).toBe(false);

    act(() => {
      props.onConfirm(new Date(2025, 5, 20));
    });

    expect(handleChange).toHaveBeenCalledWith('2025-06-20');
    const propsAfter = mockDateTimePickerModal.mock.calls.at(-1)?.[0] as { isVisible: boolean };
    expect(propsAfter.isVisible).toBe(false);
  });

  test('native picker onCancel hides the modal without committing a date', () => {
    const handleChange = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tree: any;
    act(() => {
      tree = renderer.create(<DatePicker value="" onChange={handleChange} />);
    });

    const input = tree!.root.findByProps({ accessibilityLabel: 'Date' });
    act(() => {
      input.props.onFocus();
    });

    let props = mockDateTimePickerModal.mock.calls.at(-1)?.[0] as {
      isVisible: boolean;
      onCancel: () => void;
    };
    expect(props.isVisible).toBe(true);

    act(() => {
      props.onCancel();
    });

    expect(handleChange).not.toHaveBeenCalled();
    props = mockDateTimePickerModal.mock.calls.at(-1)?.[0] as {
      isVisible: boolean;
      onCancel: () => void;
    };
    expect(props.isVisible).toBe(false);
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

  test('parseISODate defaults a missing month/day to the 1st', () => {
    const d = parseISODate('2025');
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

describe('DatePicker on web platform', () => {
  let originalOS: typeof Platform.OS;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  test('renders a native date input and commits the parsed value on change', () => {
    const handleChange = jest.fn();
    let tree: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<DatePicker value="2025-06-01" onChange={handleChange} />);
    });
    const input = tree!.root.findByProps({ type: 'date' });
    act(() => {
      input.props.onChange({ target: { value: '2025-06-20' } });
    });
    expect(handleChange).toHaveBeenCalledWith('2025-06-20');
  });

  test('does not mount the native picker modal on web', () => {
    const handleChange = jest.fn();
    act(() => {
      renderer.create(<DatePicker value="" onChange={handleChange} />);
    });
    expect(mockDateTimePickerModal).not.toHaveBeenCalled();
  });
});

describe('getNextMonday when today is already Monday', () => {
  beforeAll(() => {
    // 2025-06-16 is a Monday, where (8 - dow) % 7 alone would compute 0.
    jest.useFakeTimers().setSystemTime(new Date('2025-06-16T12:00:00'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  test('rolls forward a full week instead of returning today', () => {
    expect(toISODate(getNextMonday())).toBe('2025-06-23');
  });
});
