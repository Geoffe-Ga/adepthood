import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type {
  AudioAdapter,
  CueKind,
  RandomIntervalBellConfig,
  RandomIntervalBellMetadata,
  RitualState,
} from '../../engine/types';
import RandomIntervalBellView from '../RandomIntervalBellView';

import { fakeControls, fakeState } from './fixtures';

const baseConfig: RandomIntervalBellConfig = {
  mode: 'random_interval_bell',
  duration_minutes: 2,
  min_interval_seconds: 10,
  max_interval_seconds: 20,
  bell_tone: 'bowl',
};

type PlayFn = (kind: CueKind) => void;

function fakeAudio(): AudioAdapter & { play: jest.Mock<PlayFn>; dispose: jest.Mock<() => void> } {
  return { play: jest.fn<PlayFn>(), dispose: jest.fn<() => void>() };
}

/** Cycling seeded RNG so the schedule is deterministic in tests. */
function seededRng(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}

type FakeAudio = AudioAdapter & { play: jest.Mock<PlayFn> };

interface Harness {
  config?: RandomIntervalBellConfig;
  audio: FakeAudio;
  random: () => number;
  onMetadataChange: jest.Mock<(metadata: RandomIntervalBellMetadata) => void>;
}

function harness(over: Partial<Harness> = {}): Required<Harness> {
  return {
    config: over.config ?? baseConfig,
    audio: over.audio ?? fakeAudio(),
    random: over.random ?? (() => 0.5),
    onMetadataChange: over.onMetadataChange ?? jest.fn(),
  };
}

function renderView(h: Required<Harness>, controls = fakeControls()) {
  const element = (state: RitualState): React.JSX.Element => (
    <RandomIntervalBellView
      config={h.config}
      state={state}
      controls={controls}
      random={h.random}
      audio={h.audio}
      onMetadataChange={h.onMetadataChange}
    />
  );
  return { element, ...render(element(fakeState({ status: 'idle' }))) };
}

describe('RandomIntervalBellView — rendering', () => {
  it('renders the elapsed clock and the shared controls bar', () => {
    const { getByTestId } = renderView(harness());
    expect(getByTestId('random-interval-bell-elapsed').props.children).toBe('00:00');
    expect(getByTestId('ritual-start')).toBeTruthy();
  });

  it('shows the struck-of-total bell count once a session is running', () => {
    const h = harness();
    const { element, rerender, getByTestId } = renderView(h);
    // duration 120s, every gap 15s (rng 0.5) → 7 offsets fit before 120s.
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    expect(getByTestId('random-interval-bell-count').props.children).toBe('0 / 7 bells');
  });

  it('shows the "next bell" hint while running', () => {
    const h = harness();
    const { element, rerender, getByTestId } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    expect(getByTestId('random-interval-bell-next').props.children).toBe('Next bell in ~15s');
  });

  it('hides the "next bell" hint when not running', () => {
    const { queryByTestId } = renderView(harness());
    expect(queryByTestId('random-interval-bell-next')).toBeNull();
  });
});

describe('RandomIntervalBellView — bell scheduling', () => {
  it('strikes a bell each time a scheduled offset is passed', () => {
    const h = harness();
    const { element, rerender } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    expect(h.audio.play).not.toHaveBeenCalledWith('interval_bell');
    rerender(element(fakeState({ status: 'running', elapsedMs: 16_000 })));
    rerender(element(fakeState({ status: 'running', elapsedMs: 31_000 })));
    const intervalPlays = h.audio.play.mock.calls.filter(([kind]) => kind === 'interval_bell');
    expect(intervalPlays).toHaveLength(2);
  });

  it('emits metadata with one in-bounds gap per struck bell on completion', () => {
    const h = harness({ random: seededRng([0, 0.999, 0.5, 0.25, 0.75]) });
    const { element, rerender } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    rerender(element(fakeState({ status: 'complete', elapsedMs: 120_000 })));
    const last = h.onMetadataChange.mock.calls.at(-1)?.[0];
    expect(last?.mode).toBe('random_interval_bell');
    expect(last?.interval_seconds).toHaveLength(last?.bells_struck ?? -1);
    for (const gap of last?.interval_seconds ?? []) {
      expect(gap).toBeGreaterThanOrEqual(baseConfig.min_interval_seconds);
      expect(gap).toBeLessThanOrEqual(baseConfig.max_interval_seconds);
    }
  });

  it('emits the exact deltas for a fixed RNG', () => {
    const h = harness();
    const { element, rerender } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    rerender(element(fakeState({ status: 'complete', elapsedMs: 120_000 })));
    expect(h.onMetadataChange).toHaveBeenLastCalledWith({
      mode: 'random_interval_bell',
      bells_struck: 7,
      interval_seconds: [15, 15, 15, 15, 15, 15, 15],
    });
  });

  it('caps the schedule at max_bells', () => {
    const h = harness({ config: { ...baseConfig, max_bells: 3 } });
    const { element, rerender, getByTestId } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    expect(getByTestId('random-interval-bell-count').props.children).toBe('0 / 3 bells');
  });

  it('clears the schedule when the session is cancelled back to idle', () => {
    const h = harness();
    const { element, rerender, getByTestId } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 50_000 })));
    rerender(element(fakeState({ status: 'idle', elapsedMs: 0 })));
    expect(getByTestId('random-interval-bell-count').props.children).toBe('0 / 0 bells');
  });
});

describe('RandomIntervalBellView — boundary bells', () => {
  it('plays the start bell on idle → running and the end bell on completion', () => {
    const h = harness();
    const { element, rerender } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    expect(h.audio.play).toHaveBeenCalledWith('start_bell');
    rerender(element(fakeState({ status: 'complete', elapsedMs: 120_000 })));
    expect(h.audio.play).toHaveBeenCalledWith('end_bell');
  });

  it('suppresses the start and end bells when the config disables them', () => {
    const h = harness({ config: { ...baseConfig, start_bell: false, end_bell: false } });
    const { element, rerender } = renderView(h);
    rerender(element(fakeState({ status: 'running', elapsedMs: 0 })));
    rerender(element(fakeState({ status: 'complete', elapsedMs: 120_000 })));
    expect(h.audio.play).not.toHaveBeenCalledWith('start_bell');
    expect(h.audio.play).not.toHaveBeenCalledWith('end_bell');
  });
});

describe('RandomIntervalBellView — adapter lifecycle', () => {
  it('renders with the default audial and RNG dependencies', () => {
    const { unmount, getByTestId } = render(
      <RandomIntervalBellView
        config={baseConfig}
        state={fakeState({ status: 'idle' })}
        controls={fakeControls()}
      />,
    );
    expect(getByTestId('random-interval-bell-view')).toBeTruthy();
    unmount();
  });

  it('disposes an injected adapter that exposes dispose on unmount', () => {
    const audio = fakeAudio();
    const { unmount } = renderView(harness({ audio }));
    unmount();
    expect(audio.dispose).toHaveBeenCalledTimes(1);
  });

  it('unmounts cleanly when the injected adapter omits dispose', () => {
    const audio: FakeAudio = { play: jest.fn<PlayFn>() };
    const { unmount } = renderView(harness({ audio }));
    expect(() => unmount()).not.toThrow();
  });
});
