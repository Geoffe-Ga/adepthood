import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { RandomIntervalBellConfig } from '../../../engine/types';
import { validateRandomIntervalBell } from '../../../engine/validation';
import RandomIntervalBellForm from '../RandomIntervalBellForm';

const base: RandomIntervalBellConfig = {
  mode: 'random_interval_bell',
  duration_minutes: 20,
  min_interval_seconds: 30,
  max_interval_seconds: 180,
  bell_tone: 'bowl',
};

describe('RandomIntervalBellForm — core fields', () => {
  it('renders duration, min, max, and bell-tone controls', () => {
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('random-interval-bell-duration').props.value).toBe('20');
    expect(getByTestId('random-interval-bell-min').props.value).toBe('30');
    expect(getByTestId('random-interval-bell-max').props.value).toBe('180');
    expect(getByTestId('random-interval-bell-tone-bowl')).toBeTruthy();
    expect(getByTestId('random-interval-bell-tone-chime')).toBeTruthy();
    expect(getByTestId('random-interval-bell-tone-gong')).toBeTruthy();
  });

  it('updates the duration', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('random-interval-bell-duration'), '45');
    expect(onChange).toHaveBeenCalledWith({ ...base, duration_minutes: 45 });
  });

  it('updates the min and max intervals', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('random-interval-bell-min'), '60');
    expect(onChange).toHaveBeenCalledWith({ ...base, min_interval_seconds: 60 });
    fireEvent.changeText(getByTestId('random-interval-bell-max'), '240');
    expect(onChange).toHaveBeenCalledWith({ ...base, max_interval_seconds: 240 });
  });

  it('changes the bell tone', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('random-interval-bell-tone-gong'));
    expect(onChange).toHaveBeenCalledWith({ ...base, bell_tone: 'gong' });
  });
});

describe('RandomIntervalBellForm — Advanced section', () => {
  it('keeps the advanced fields collapsed until the toggle is pressed', () => {
    const { queryByTestId } = render(<RandomIntervalBellForm value={base} onChange={jest.fn()} />);
    expect(queryByTestId('random-interval-bell-advanced-fields')).toBeNull();
  });

  it('reveals max bells and the start/end bell toggles when expanded', () => {
    const { getByTestId, queryByTestId } = render(
      <RandomIntervalBellForm value={base} onChange={jest.fn()} />,
    );
    fireEvent.press(getByTestId('random-interval-bell-advanced-toggle'));
    expect(getByTestId('random-interval-bell-advanced-fields')).toBeTruthy();
    expect(getByTestId('random-interval-bell-max-bells')).toBeTruthy();
    expect(getByTestId('random-interval-bell-start-bell')).toBeTruthy();
    expect(getByTestId('random-interval-bell-end-bell')).toBeTruthy();
    fireEvent.press(getByTestId('random-interval-bell-advanced-toggle'));
    expect(queryByTestId('random-interval-bell-advanced-fields')).toBeNull();
  });

  it('sets a max-bells cap and clears it back to no cap', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('random-interval-bell-advanced-toggle'));
    fireEvent.changeText(getByTestId('random-interval-bell-max-bells'), '12');
    expect(onChange).toHaveBeenCalledWith({ ...base, max_bells: 12 });
    fireEvent.changeText(getByTestId('random-interval-bell-max-bells'), '');
    expect(onChange).toHaveBeenCalledWith({ ...base, max_bells: null });
  });

  it('toggles the start and end bells', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RandomIntervalBellForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('random-interval-bell-advanced-toggle'));
    fireEvent(getByTestId('random-interval-bell-start-bell'), 'valueChange', false);
    expect(onChange).toHaveBeenCalledWith({ ...base, start_bell: false });
    fireEvent(getByTestId('random-interval-bell-end-bell'), 'valueChange', false);
    expect(onChange).toHaveBeenCalledWith({ ...base, end_bell: false });
  });
});

describe('validateRandomIntervalBell', () => {
  it('accepts a well-formed config', () => {
    expect(validateRandomIntervalBell(base)).toEqual([]);
  });

  it('accepts an optional max-bells cap within range', () => {
    expect(validateRandomIntervalBell({ ...base, max_bells: 50 })).toEqual([]);
  });

  it('rejects a maximum interval below the minimum', () => {
    const errors = validateRandomIntervalBell({
      ...base,
      min_interval_seconds: 120,
      max_interval_seconds: 60,
    });
    expect(errors.some((e) => /greater than or equal/i.test(e))).toBe(true);
  });

  it('rejects a minimum interval that cannot fit in the duration', () => {
    const errors = validateRandomIntervalBell({
      ...base,
      duration_minutes: 1,
      min_interval_seconds: 120,
      max_interval_seconds: 180,
    });
    expect(errors.some((e) => /fit within the total duration/i.test(e))).toBe(true);
  });

  it('rejects intervals outside the per-field floor and ceiling', () => {
    expect(validateRandomIntervalBell({ ...base, min_interval_seconds: 2 })).not.toEqual([]);
    expect(validateRandomIntervalBell({ ...base, max_interval_seconds: 9_999 })).not.toEqual([]);
  });

  it('rejects a non-integer interval', () => {
    expect(validateRandomIntervalBell({ ...base, min_interval_seconds: 30.5 })).not.toEqual([]);
  });

  it('rejects an out-of-range max-bells cap', () => {
    expect(validateRandomIntervalBell({ ...base, max_bells: 0 })).not.toEqual([]);
    expect(validateRandomIntervalBell({ ...base, max_bells: 5_000 })).not.toEqual([]);
  });

  it('rejects an unknown bell tone', () => {
    const errors = validateRandomIntervalBell({
      ...base,
      bell_tone: 'kazoo' as RandomIntervalBellConfig['bell_tone'],
    });
    expect(errors).toContain('Unknown bell tone');
  });

  it('rejects a duration outside the allowed range', () => {
    expect(validateRandomIntervalBell({ ...base, duration_minutes: 0 })).not.toEqual([]);
  });
});
