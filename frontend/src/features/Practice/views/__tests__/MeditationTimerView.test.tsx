import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Circle } from 'react-native-svg';

import MeditationTimerView from '../MeditationTimerView';

import { fakeControls, fakeState } from './fixtures';

// The animated progress arc is the only Circle that carries a strokeDashoffset;
// its value is CIRCUMFERENCE * (1 - clamp(progress, 0, 1)). Reading it back lets
// us pin the clamp rather than merely asserting the view does not throw.
function progressDashOffset(progress: number): number {
  const { UNSAFE_getAllByType } = render(
    <MeditationTimerView
      state={fakeState({ progress, remainingMs: 0 })}
      controls={fakeControls()}
    />,
  );
  const arc = UNSAFE_getAllByType(Circle).find(
    (circle) => circle.props.strokeDashoffset !== undefined,
  );
  return arc?.props.strokeDashoffset as number;
}

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
    // Baselines: a full circle (progress 0) leaves the whole circumference as
    // offset; a complete circle (progress 1) leaves zero offset.
    const fullOffset = progressDashOffset(0);
    const emptyOffset = progressDashOffset(1);
    expect(fullOffset).toBeGreaterThan(0);
    expect(emptyOffset).toBe(0);

    // Over- and under-shooting progress must clamp to those same endpoints,
    // never overshoot into a negative or double-circumference offset.
    expect(progressDashOffset(2)).toBe(emptyOffset);
    expect(progressDashOffset(-1)).toBe(fullOffset);
  });
});
