import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type { MetronomeConfig } from '../../engine/types';
import MetronomeView from '../MetronomeView';

import { fakeControls, fakeState } from './fixtures';

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

  it('re-renders cleanly when cuesStruck advances (Animated.sequence runs)', () => {
    const controls = fakeControls();
    const initialState = fakeState({ status: 'running', cuesStruck: 1, elapsedMs: 1000 });
    const { rerender, getByTestId } = render(
      <MetronomeView config={config} state={initialState} controls={controls} />,
    );
    const advanced = fakeState({ status: 'running', cuesStruck: 5, elapsedMs: 5000 });
    rerender(<MetronomeView config={config} state={advanced} controls={controls} />);
    expect(getByTestId('metronome-pulse')).toBeTruthy();
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
