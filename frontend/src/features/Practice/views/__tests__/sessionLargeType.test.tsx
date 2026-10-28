/**
 * Large-type structural proxy for the session views (#3072 AC7).
 *
 * Jest cannot measure layout, so this asserts the structure that decides
 * whether large OS text sizes clip: the fixed-geometry display numerals carry
 * a named font-scale ceiling, and the control labels carry neither a
 * truncating `numberOfLines` nor a font-scale cap below 2x. A real fontScale-2
 * layout check needs a device or browser run (#3072 AC19/AC20).
 */
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import MeditationTimerView from '../MeditationTimerView';
import MetronomeView from '../MetronomeView';
import RitualControlsBar from '../RitualControlsBar';
import { SESSION_DISPLAY_MAX_FONT_SCALE } from '../shared';

import { fakeControls, fakeState } from './fixtures';

const LARGEST_SUPPORTED_SCALE = 2;

describe('session views under large type', () => {
  it('names a display-numeral font-scale ceiling above 1x', () => {
    expect(SESSION_DISPLAY_MAX_FONT_SCALE).toBeGreaterThan(1);
  });

  it('caps the 42pt ring clock, whose ring has fixed geometry', () => {
    render(
      <MeditationTimerView state={fakeState({ remainingMs: 600_000 })} controls={fakeControls()} />,
    );
    expect(screen.getByTestId('meditation-time-remaining').props.maxFontSizeMultiplier).toBe(
      SESSION_DISPLAY_MAX_FONT_SCALE,
    );
  });

  it('caps the 84pt bpm numeral', () => {
    render(
      <MetronomeView
        config={{
          mode: 'metronome',
          bpm: 60,
          timer: { mode: 'meditation_timer', duration_minutes: 10 },
        }}
        state={fakeState()}
        controls={fakeControls()}
      />,
    );
    expect(screen.getByTestId('metronome-bpm').props.maxFontSizeMultiplier).toBe(
      SESSION_DISPLAY_MAX_FONT_SCALE,
    );
  });

  it.each(['idle', 'running', 'paused'] as const)(
    'never truncates or under-scales a %s control label',
    (status) => {
      const view = render(<RitualControlsBar status={status} controls={fakeControls()} />);
      const labels = view.UNSAFE_getAllByType(Text);
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.props.numberOfLines).toBeUndefined();
        const cap = label.props.maxFontSizeMultiplier as number | undefined;
        if (cap !== undefined && cap !== 0)
          expect(cap).toBeGreaterThanOrEqual(LARGEST_SUPPORTED_SCALE);
      }
    },
  );
});
