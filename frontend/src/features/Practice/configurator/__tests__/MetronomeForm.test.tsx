import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MetronomeConfig } from '../../engine/types';
import MetronomeForm from '../forms/MetronomeForm';

const base: MetronomeConfig = {
  mode: 'metronome',
  bpm: 60,
  timer: { mode: 'meditation_timer', duration_minutes: 10 },
};

describe('MetronomeForm', () => {
  it('renders the BPM value', () => {
    const { getByTestId } = render(<MetronomeForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('metronome-bpm-value').props.children).toBe(60);
  });

  it('increments BPM by ±1', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MetronomeForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('metronome-bpm-plus'));
    expect(onChange).toHaveBeenCalledWith({ ...base, bpm: 61 });
  });

  it('increments BPM by ±5', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MetronomeForm value={base} onChange={onChange} />);
    fireEvent.press(getByTestId('metronome-bpm-plus-big'));
    expect(onChange).toHaveBeenCalledWith({ ...base, bpm: 65 });
  });

  it('clamps BPM to the [20, 240] window', () => {
    const onChange = jest.fn();
    const lowerBound = { ...base, bpm: 20 };
    const { getByTestId, rerender } = render(
      <MetronomeForm value={lowerBound} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('metronome-bpm-minus'));
    expect(onChange).toHaveBeenLastCalledWith({ ...lowerBound, bpm: 20 });

    const upperBound = { ...base, bpm: 240 };
    rerender(<MetronomeForm value={upperBound} onChange={onChange} />);
    fireEvent.press(getByTestId('metronome-bpm-plus'));
    expect(onChange).toHaveBeenLastCalledWith({ ...upperBound, bpm: 240 });
  });

  it('embeds the inner meditation timer form for the surrounding window', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<MetronomeForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('metronome-timer-duration'), '12');
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      timer: { ...base.timer, duration_minutes: 12 },
    });
  });
});
