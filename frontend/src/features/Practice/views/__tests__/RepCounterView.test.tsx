import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { RepCounterConfig } from '../../engine/types';
import RepCounterView from '../RepCounterView';

import { fakeControls, fakeState } from './fixtures';

const config: RepCounterConfig = {
  mode: 'rep_counter',
  target_reps: 30,
  unit_label: 'breaths',
};

describe('RepCounterView', () => {
  it('renders the current rep count, target, and unit label', () => {
    const { getByTestId, getByText } = render(
      <RepCounterView
        config={config}
        state={fakeState({ status: 'running', repCount: 7 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('rep-counter-count').props.children).toBe(7);
    expect(getByText('of 30')).toBeTruthy();
    expect(getByTestId('rep-counter-unit').props.children).toBe('breaths');
  });

  it('fires controls.tap when the tap zone is pressed while running', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <RepCounterView
        config={config}
        state={fakeState({ status: 'running' })}
        controls={controls}
      />,
    );
    fireEvent.press(getByTestId('rep-counter-tap-zone'));
    expect(controls.tap).toHaveBeenCalledTimes(1);
  });

  it('does not fire controls.tap when not running', () => {
    const controls = fakeControls();
    const { getByTestId } = render(
      <RepCounterView config={config} state={fakeState({ status: 'idle' })} controls={controls} />,
    );
    fireEvent.press(getByTestId('rep-counter-tap-zone'));
    expect(controls.tap).not.toHaveBeenCalled();
  });

  it('shows the time-cap countdown when time_cap_minutes is set', () => {
    const capped: RepCounterConfig = { ...config, time_cap_minutes: 2 };
    const { getByTestId } = render(
      <RepCounterView
        config={capped}
        state={fakeState({ status: 'running', elapsedMs: 30_000 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('rep-counter-time-cap').props.children).toEqual(['time cap: ', '01:30']);
  });

  it('omits the time-cap row when time_cap_minutes is unset', () => {
    const { queryByTestId } = render(
      <RepCounterView
        config={config}
        state={fakeState({ status: 'running' })}
        controls={fakeControls()}
      />,
    );
    expect(queryByTestId('rep-counter-time-cap')).toBeNull();
  });
});
