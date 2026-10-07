/**
 * The mindful-anchor view reads the engine's wall-clock elapsed instead of a
 * view-local 1 Hz counter. A local `setInterval` stalls while the app is
 * backgrounded, so a sitting spent outside the app undercounted its duration
 * and tripped the soft minimum-duration gate wrongly (#3072).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { MindfulAnchorConfig, MindfulAnchorMetadata } from '../../engine/types';
import MindfulAnchorView from '../MindfulAnchorView';

import { fakeControls, fakeState } from './fixtures';

const TEN_MINUTES_MS = 600_000;

const config: MindfulAnchorConfig = {
  mode: 'mindful_anchor',
  instruction: 'Step outside and rest a bare palm on the grass.',
  min_duration_seconds: 300,
  options: [{ key: 'grass', label: 'Grass' }],
  require_option_choice: true,
};

describe('MindfulAnchorView engine clock', () => {
  it('saved duration comes from engine elapsed', () => {
    const onComplete = jest.fn<(metadata: MindfulAnchorMetadata) => void>();
    const controls = fakeControls();
    const element = (elapsedMs: number, status: 'idle' | 'running'): React.JSX.Element => (
      <MindfulAnchorView
        config={config}
        state={fakeState({ status, elapsedMs })}
        controls={controls}
        onComplete={onComplete}
      />
    );
    const view = render(element(0, 'idle'));
    fireEvent.press(view.getByTestId('mindful-anchor-option-grass'));
    view.rerender(element(TEN_MINUTES_MS, 'running'));

    expect(view.getByTestId('mindful-anchor-elapsed-time')).toHaveTextContent('10:00');
    fireEvent.press(view.getByTestId('mindful-anchor-save'));

    expect(view.queryByTestId('mindful-anchor-confirm')).toBeNull();
    expect(onComplete).toHaveBeenCalledWith({
      mode: 'mindful_anchor',
      chosen_option_key: 'grass',
      duration_seconds: 600,
      met_min_duration: true,
    });
    expect(controls.complete).toHaveBeenCalledTimes(1);
  });
});
