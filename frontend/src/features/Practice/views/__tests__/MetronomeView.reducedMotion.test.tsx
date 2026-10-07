/**
 * The metronome pulse is decorative motion on every beat (1 800 pulses in the
 * stage-6 canonical 30-minute sit); it must stand still under the OS "Reduce
 * Motion" setting (#3072 AC5). The tick itself is still felt as haptics.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Animated } from 'react-native';

import type { MetronomeConfig } from '../../engine/types';
import MetronomeView from '../MetronomeView';

import { fakeControls, fakeState } from './fixtures';

import * as reducedMotion from '@/hooks/useReducedMotion';

const config: MetronomeConfig = {
  mode: 'metronome',
  bpm: 60,
  timer: { mode: 'meditation_timer', duration_minutes: 30 },
};

function strikeOnce(): void {
  const controls = fakeControls();
  const view = render(
    <MetronomeView
      config={config}
      state={fakeState({ status: 'running', cuesStruck: 1 })}
      controls={controls}
    />,
  );
  view.rerender(
    <MetronomeView
      config={config}
      state={fakeState({ status: 'running', cuesStruck: 2 })}
      controls={controls}
    />,
  );
}

describe('MetronomeView pulse and reduced motion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('no pulse animation under reduced motion', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const sequence = jest.spyOn(Animated, 'sequence');
    strikeOnce();
    expect(sequence).not.toHaveBeenCalled();
  });

  it('pulses on each beat when motion is allowed', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const sequence = jest.spyOn(Animated, 'sequence');
    strikeOnce();
    expect(sequence).toHaveBeenCalledTimes(1);
  });
});
