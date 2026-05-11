import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import CountUpTimerView from '../CountUpTimerView';

import { fakeControls, fakeState } from './fixtures';

describe('CountUpTimerView', () => {
  it('shows the elapsed time formatted as mm:ss', () => {
    const { getByTestId } = render(
      <CountUpTimerView state={fakeState({ elapsedMs: 125_000 })} controls={fakeControls()} />,
    );
    expect(getByTestId('count-up-elapsed').props.children).toBe('02:05');
  });

  it('renders the "End session" button while running and routes to controls.complete', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <CountUpTimerView
        state={fakeState({ status: 'running', elapsedMs: 60_000 })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('count-up-end'));
    expect(controls.complete).toHaveBeenCalledTimes(1);
  });

  it('hides the "End session" button when not running', () => {
    const { queryByTestId } = render(
      <CountUpTimerView state={fakeState({ status: 'idle' })} controls={fakeControls()} />,
    );
    expect(queryByTestId('count-up-end')).toBeNull();
  });

  it('renders the shared controls bar', () => {
    const { getByTestId } = render(
      <CountUpTimerView state={fakeState({ status: 'paused' })} controls={fakeControls()} />,
    );
    expect(getByTestId('ritual-resume')).toBeTruthy();
    expect(getByTestId('ritual-cancel')).toBeTruthy();
  });
});
