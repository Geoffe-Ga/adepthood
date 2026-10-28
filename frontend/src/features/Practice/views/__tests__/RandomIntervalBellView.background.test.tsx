/**
 * The random-bell view owns its own bell loop (the engine schedules no cues
 * for this mode), so it has to coalesce missed bells itself (#3072 AC3).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type {
  AudioAdapter,
  CueKind,
  IntervalBellTone,
  RandomIntervalBellConfig,
  RitualState,
} from '../../engine/types';
import RandomIntervalBellView from '../RandomIntervalBellView';

import { fakeControls, fakeState } from './fixtures';

type PlayFn = (kind: CueKind, tone?: IntervalBellTone) => void;

// A fixed RNG of 0.5 spaces bells 15 s apart: 15, 30, 45, 60, 75, 90, 105 s.
const config: RandomIntervalBellConfig = {
  mode: 'random_interval_bell',
  duration_minutes: 2,
  min_interval_seconds: 10,
  max_interval_seconds: 20,
  bell_tone: 'bowl',
};

function setup() {
  const play = jest.fn<PlayFn>();
  const audio: AudioAdapter = { play };
  const controls = fakeControls();
  const element = (state: RitualState): React.JSX.Element => (
    <RandomIntervalBellView
      config={config}
      state={state}
      controls={controls}
      random={() => 0.5}
      audio={audio}
    />
  );
  const view = render(element(fakeState({ status: 'idle' })));
  return { play, element, view };
}

function intervalPlays(play: jest.Mock<PlayFn>): number {
  return play.mock.calls.filter(([kind]) => kind === 'interval_bell').length;
}

describe('RandomIntervalBellView after a background trip', () => {
  it('jump past several random bells strikes once', () => {
    const { play, element, view } = setup();
    view.rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    view.rerender(element(fakeState({ status: 'running', elapsedMs: 65_000 })));
    expect(intervalPlays(play)).toBe(1);
    expect(view.getByTestId('random-interval-bell-count').props.children).toBe('4 / 7 bells');
  });

  it('still strikes each bell when they pass one at a time', () => {
    const { play, element, view } = setup();
    view.rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    for (const ms of [15_000, 30_000, 45_000]) {
      view.rerender(element(fakeState({ status: 'running', elapsedMs: ms })));
    }
    expect(intervalPlays(play)).toBe(3);
  });

  it('does not ring the start bell again on resume', () => {
    const { play, element, view } = setup();
    view.rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    view.rerender(element(fakeState({ status: 'paused', elapsedMs: 5_000 })));
    view.rerender(element(fakeState({ status: 'running', elapsedMs: 5_000 })));
    expect(play.mock.calls.filter(([kind]) => kind === 'start_bell')).toHaveLength(1);
  });
});
