import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MeditationTimerConfig } from '../../engine/types';
import MeditationTimerForm from '../forms/MeditationTimerForm';

const base: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 10,
  start_bell: true,
  halfway_bell: false,
  end_bell: true,
};

describe('MeditationTimerForm', () => {
  it('renders the current duration', () => {
    const { getByTestId } = render(<MeditationTimerForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('meditation-timer-duration').props.value).toBe('10');
  });

  it('emits an updated duration when the field changes', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MeditationTimerForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('meditation-timer-duration'), '20');
    expect(onChange).toHaveBeenCalledWith({ ...base, duration_minutes: 20 });
  });

  it('toggles the halfway bell', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MeditationTimerForm value={base} onChange={onChange} />);
    fireEvent(getByTestId('meditation-timer-halfway-bell'), 'valueChange', true);
    expect(onChange).toHaveBeenCalledWith({ ...base, halfway_bell: true });
  });

  it('uses an id prefix when embedded', () => {
    const { getByTestId } = render(
      <MeditationTimerForm value={base} onChange={jest.fn()} idPrefix="metronome-timer" />,
    );
    expect(getByTestId('metronome-timer-form')).toBeTruthy();
    expect(getByTestId('metronome-timer-duration')).toBeTruthy();
  });
});
