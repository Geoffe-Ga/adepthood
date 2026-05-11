import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type { IntervalBellConfig } from '../../engine/types';
import IntervalBellView from '../IntervalBellView';

import { fakeControls, fakeState } from './fixtures';

const config: IntervalBellConfig = {
  mode: 'interval_bell',
  duration_minutes: 20,
  interval_minutes: 5,
  bell_tone: 'bowl',
};

describe('IntervalBellView', () => {
  it('renders the time until the next bell from nextCueAtMs - elapsedMs', () => {
    const { getByTestId } = render(
      <IntervalBellView
        config={config}
        state={fakeState({
          status: 'running',
          elapsedMs: 4 * 60_000,
          nextCueAtMs: 5 * 60_000,
        })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('interval-bell-next').props.children).toBe('01:00');
  });

  it('lists every scheduled cue offset and marks the upcoming one', () => {
    const { getByTestId } = render(
      <IntervalBellView
        config={config}
        state={fakeState({ status: 'running', cuesStruck: 2, nextCueAtMs: 10 * 60_000 })}
        controls={fakeControls()}
      />,
    );
    // 4 intervals + start + end = 6 rows
    expect(getByTestId('interval-bell-offsets')).toBeTruthy();
    // First struck row shows the check mark
    expect(getByTestId('interval-bell-row-mark-0').props.children).toBe('✓');
    // Third row (index 2 after two struck) is the upcoming row
    expect(getByTestId(`interval-bell-row-mark-${10 * 60_000}`).props.children).toBe('→');
  });

  it('renders 00:00 when there is no next cue (final bell struck)', () => {
    const { getByTestId } = render(
      <IntervalBellView
        config={config}
        state={fakeState({ status: 'complete', nextCueAtMs: null, cuesStruck: 6 })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('interval-bell-next').props.children).toBe('00:00');
  });

  it('renders the shared controls bar', () => {
    const { getByTestId } = render(
      <IntervalBellView
        config={config}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('ritual-start')).toBeTruthy();
  });
});
