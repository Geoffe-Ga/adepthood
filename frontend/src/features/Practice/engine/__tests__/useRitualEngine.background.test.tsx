/**
 * Background / foreground behaviour of the ritual engine (#3072 AC3, AC4).
 *
 * On native, JS timers stall while the app is backgrounded. On return, the
 * wall-clock engine jumps forward past every cue that fell due meanwhile. The
 * user should hear at most the one cue that is due now — not a machine-gun
 * burst of every missed bell — and the display should reconcile the instant
 * the app is foregrounded rather than on the next 100 ms tick.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';
import { AppState } from 'react-native';

import type {
  AudioAdapter,
  CueKind,
  EngineDeps,
  IntervalBellConfig,
  IntervalHandle,
  MetronomeConfig,
  ModeConfig,
} from '../types';
import { useRitualEngine } from '../useRitualEngine';

const MIN = 60_000;

type PlayFn = (kind: CueKind, tone?: IntervalBellConfig['bell_tone']) => void;

interface Harness {
  deps: EngineDeps;
  play: jest.Mock<PlayFn>;
  /** Fire the engine's ticker once, as a resumed JS thread would. */
  tick: () => void;
  setNow: (ms: number) => void;
}

function makeHarness(): Harness {
  let now = 0;
  let tickCb: (() => void) | null = null;
  const play = jest.fn<PlayFn>();
  const audio: AudioAdapter = { play };
  return {
    play,
    tick: () => tickCb?.(),
    setNow: (ms) => {
      now = ms;
    },
    deps: {
      now: () => now,
      setIntervalMs: (cb): IntervalHandle => {
        tickCb = cb;
        return 1 as unknown as IntervalHandle;
      },
      clearIntervalMs: () => {
        tickCb = null;
      },
      audio,
      haptics: { cue: () => undefined },
    },
  };
}

function renderEngine(config: ModeConfig, deps: EngineDeps) {
  return renderHook(() => useRitualEngine(config, deps));
}

const tenBells: IntervalBellConfig = {
  mode: 'interval_bell',
  duration_minutes: 10,
  interval_minutes: 1,
  bell_tone: 'bowl',
};

describe('useRitualEngine — missed cues after a background trip', () => {
  it('resume after missed cues emits one cue, not a burst', () => {
    const h = makeHarness();
    const { result } = renderEngine(tenBells, h.deps);
    act(() => result.current[1].start());
    h.play.mockClear();

    h.setNow(6.5 * MIN);
    act(() => h.tick());

    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.play).toHaveBeenCalledWith('interval_bell', 'bowl');
    expect(result.current[0].cuesStruck).toBe(7);
  });

  it('still sounds the start bell and every cue due at 0 ms', () => {
    const h = makeHarness();
    const { result } = renderEngine(tenBells, h.deps);
    act(() => result.current[1].start());
    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.play).toHaveBeenCalledWith('start_bell');
  });

  it('sounds each cue in ordinary foreground ticking', () => {
    const h = makeHarness();
    const { result } = renderEngine(tenBells, h.deps);
    act(() => result.current[1].start());
    h.play.mockClear();
    for (const minute of [1, 2, 3]) {
      h.setNow(minute * MIN + 50);
      act(() => h.tick());
    }
    expect(h.play).toHaveBeenCalledTimes(3);
  });

  it('end bell plus final metronome tick at totalMs both sound on return', () => {
    const metronome: MetronomeConfig = {
      mode: 'metronome',
      bpm: 60,
      timer: { mode: 'meditation_timer', duration_minutes: 1, start_bell: true, end_bell: true },
    };
    const h = makeHarness();
    const { result } = renderEngine(metronome, h.deps);
    act(() => result.current[1].start());
    h.play.mockClear();

    h.setNow(5 * MIN);
    act(() => h.tick());

    const kinds = h.play.mock.calls.map(([kind]) => kind);
    expect(kinds).toContain('end_bell');
    expect(kinds).toContain('metronome_tick');
    // Every tick in the last second (here exactly one, at 60 bpm) sounds; the
    // other 58 missed ticks do not.
    expect(kinds.filter((k) => k === 'metronome_tick')).toHaveLength(1);
    expect(result.current[0].status).toBe('complete');
  });
});

describe('useRitualEngine — foreground reconcile', () => {
  let handler: ((state: AppStateStatus) => void) | undefined;
  const remove = jest.fn();

  beforeEach(() => {
    handler = undefined;
    remove.mockClear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      handler = listener as (state: AppStateStatus) => void;
      return { remove } as unknown as NativeEventSubscription;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AppState active reconciles immediately', () => {
    const h = makeHarness();
    const { result } = renderEngine(tenBells, h.deps);
    act(() => result.current[1].start());

    h.setNow(3 * MIN);
    expect(handler).toBeDefined();
    act(() => handler?.('active'));

    expect(result.current[0].elapsedMs).toBe(3 * MIN);
  });

  it('ignores the background transition itself', () => {
    const h = makeHarness();
    const { result } = renderEngine(tenBells, h.deps);
    act(() => result.current[1].start());

    h.setNow(3 * MIN);
    act(() => handler?.('background'));

    expect(result.current[0].elapsedMs).toBe(0);
  });

  it('listener removed on unmount', () => {
    const h = makeHarness();
    const { unmount } = renderEngine(tenBells, h.deps);
    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
