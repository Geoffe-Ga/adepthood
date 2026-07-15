import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Animated } from 'react-native';

import type { MetronomeConfig } from '../../engine/types';
import MetronomeView from '../MetronomeView';

import { fakeControls, fakeState } from './fixtures';

const PULSE_MAX_SCALE = 1.6;
const PULSE_REST_SCALE = 1;

const config: MetronomeConfig = {
  mode: 'metronome',
  bpm: 80,
  timer: { mode: 'meditation_timer', duration_minutes: 10 },
};

describe('MetronomeView', () => {
  it('displays the BPM value and a mm:ss mini timer derived from elapsedMs', () => {
    const { getByTestId } = render(
      <MetronomeView
        config={config}
        state={fakeState({ status: 'running', elapsedMs: 45_000 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('metronome-bpm').props.children).toBe(80);
    expect(getByTestId('metronome-mini-timer').props.children).toBe('00:45');
    expect(getByTestId('metronome-pulse')).toBeTruthy();
  });

  it('pulses the dot only when cuesStruck advances, scaling up then back to rest', () => {
    const timingSpy = jest.spyOn(Animated, 'timing');
    try {
      const controls = fakeControls();
      const initialState = fakeState({ status: 'running', cuesStruck: 1, elapsedMs: 1000 });
      const { rerender } = render(
        <MetronomeView config={config} state={initialState} controls={controls} />,
      );
      // First mount matches the initial cue count, so no pulse fires.
      expect(timingSpy).not.toHaveBeenCalled();

      // A re-render that does not advance cuesStruck must not pulse either.
      const restated = fakeState({ status: 'running', cuesStruck: 1, elapsedMs: 2000 });
      rerender(<MetronomeView config={config} state={restated} controls={controls} />);
      expect(timingSpy).not.toHaveBeenCalled();

      // Advancing cuesStruck runs the two-step scale sequence: up to the max
      // scale, then back to rest.
      const advanced = fakeState({ status: 'running', cuesStruck: 5, elapsedMs: 5000 });
      rerender(<MetronomeView config={config} state={advanced} controls={controls} />);
      expect(timingSpy).toHaveBeenCalledTimes(2);
      const toValues = timingSpy.mock.calls.map((call) => call[1].toValue);
      expect(toValues).toEqual([PULSE_MAX_SCALE, PULSE_REST_SCALE]);
    } finally {
      timingSpy.mockRestore();
    }
  });

  it('routes controls through the shared controls bar', () => {
    const { getByTestId } = render(
      <MetronomeView
        config={config}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('ritual-start')).toBeTruthy();
  });
});
