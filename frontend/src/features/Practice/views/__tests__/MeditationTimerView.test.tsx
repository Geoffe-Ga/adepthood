import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import MeditationTimerView from '../MeditationTimerView';

import { fakeControls, fakeState } from './fixtures';

describe('MeditationTimerView', () => {
  it('renders the remaining time formatted as mm:ss', () => {
    const { getByTestId } = render(
      <MeditationTimerView
        state={fakeState({ remainingMs: 305_000, progress: 0.5 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('meditation-time-remaining').props.children).toBe('05:05');
  });

  it('renders the ring and shows 00:00 when remainingMs is null', () => {
    const { getByTestId } = render(
      <MeditationTimerView state={fakeState()} controls={fakeControls()} />,
    );
    expect(getByTestId('meditation-timer-ring')).toBeTruthy();
    expect(getByTestId('meditation-time-remaining').props.children).toBe('00:00');
  });

  it('renders the Start button while idle and triggers controls.start', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <MeditationTimerView state={fakeState({ status: 'idle' })} controls={controls} />,
    );
    fireEvent.press(getByTestId('ritual-start'));
    expect(controls.start).toHaveBeenCalledTimes(1);
  });

  it('clamps progress > 1 and < 0 to the [0, 1] range for the ring offset', () => {
    expect(() =>
      render(
        <MeditationTimerView
          state={fakeState({ progress: 2, remainingMs: 0 })}
          controls={fakeControls()}
        />,
      ),
    ).not.toThrow();
    expect(() =>
      render(
        <MeditationTimerView
          state={fakeState({ progress: -1, remainingMs: 0 })}
          controls={fakeControls()}
        />,
      ),
    ).not.toThrow();
  });
});
