import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { RepCounterConfig } from '../../engine/types';
import RepCounterForm from '../forms/RepCounterForm';

const base: RepCounterConfig = {
  mode: 'rep_counter',
  target_reps: 108,
  unit_label: 'breaths',
  time_cap_minutes: null,
};

describe('RepCounterForm', () => {
  it('renders the target reps', () => {
    const { getByTestId } = render(<RepCounterForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('rep-counter-target').props.value).toBe('108');
  });

  it('rounds non-integer target reps on change', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RepCounterForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('rep-counter-target'), '7.6');
    expect(onChange).toHaveBeenCalledWith({ ...base, target_reps: 8 });
  });

  it('updates the unit label', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RepCounterForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('rep-counter-unit'), 'bows');
    expect(onChange).toHaveBeenCalledWith({ ...base, unit_label: 'bows' });
  });

  it('updates the optional time cap', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<RepCounterForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('rep-counter-time-cap'), '30');
    expect(onChange).toHaveBeenCalledWith({ ...base, time_cap_minutes: 30 });
  });

  it('clears the time cap when the field is emptied', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <RepCounterForm value={{ ...base, time_cap_minutes: 20 }} onChange={onChange} />,
    );
    fireEvent.changeText(getByTestId('rep-counter-time-cap'), '');
    expect(onChange).toHaveBeenCalledWith({ ...base, time_cap_minutes: null });
  });
});
