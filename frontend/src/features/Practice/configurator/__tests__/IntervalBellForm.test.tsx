import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { IntervalBellConfig } from '../../engine/types';
import IntervalBellForm from '../forms/IntervalBellForm';

const evenBase: IntervalBellConfig = {
  mode: 'interval_bell',
  duration_minutes: 20,
  interval_minutes: 5,
  cue_offsets_minutes: null,
  bell_tone: 'bowl',
};

const customBase: IntervalBellConfig = {
  ...evenBase,
  interval_minutes: null,
  cue_offsets_minutes: [3, 7, 12],
};

describe('IntervalBellForm', () => {
  it('renders the even-interval branch when interval_minutes is set', () => {
    const { getByTestId, queryByTestId } = render(
      <IntervalBellForm value={evenBase} onChange={jest.fn()} />,
    );
    expect(getByTestId('interval-bell-interval').props.value).toBe('5');
    expect(queryByTestId('interval-bell-offsets')).toBeNull();
  });

  it('updates duration when the field changes', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<IntervalBellForm value={evenBase} onChange={onChange} />);
    fireEvent.changeText(getByTestId('interval-bell-duration'), '30');
    expect(onChange).toHaveBeenCalledWith({ ...evenBase, duration_minutes: 30 });
  });

  it('switches to custom offsets and back', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<IntervalBellForm value={evenBase} onChange={onChange} />);
    fireEvent.press(getByTestId('interval-bell-custom'));
    expect(onChange).toHaveBeenCalledWith({
      ...evenBase,
      interval_minutes: null,
      cue_offsets_minutes: [],
    });
    onChange.mockClear();
    const { getByTestId: getCustomTestId } = render(
      <IntervalBellForm value={customBase} onChange={onChange} />,
    );
    fireEvent.press(getCustomTestId('interval-bell-even'));
    expect(onChange).toHaveBeenCalledWith({
      ...customBase,
      interval_minutes: 5,
      cue_offsets_minutes: null,
    });
  });

  it('adds a custom offset', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<IntervalBellForm value={customBase} onChange={onChange} />);
    fireEvent.changeText(getByTestId('interval-bell-offset-draft'), '15');
    fireEvent.press(getByTestId('interval-bell-offset-add'));
    expect(onChange).toHaveBeenCalledWith({
      ...customBase,
      cue_offsets_minutes: [3, 7, 12, 15],
    });
  });

  it('removes a custom offset', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<IntervalBellForm value={customBase} onChange={onChange} />);
    fireEvent.press(getByTestId('interval-bell-offset-1'));
    expect(onChange).toHaveBeenCalledWith({
      ...customBase,
      cue_offsets_minutes: [3, 12],
    });
  });

  it('changes the bell tone', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<IntervalBellForm value={evenBase} onChange={onChange} />);
    fireEvent.press(getByTestId('interval-bell-tone-gong'));
    expect(onChange).toHaveBeenCalledWith({ ...evenBase, bell_tone: 'gong' });
  });
});
