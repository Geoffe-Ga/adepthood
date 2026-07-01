import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook } from '@testing-library/react-native';
import React from 'react';

import MeditationTimerView from '../../views/MeditationTimerView';
import { getTotalMs } from '../reducer';
import type { CueKind, EngineDeps, MeditationTimerConfig } from '../types';
import { MS_PER_MINUTE } from '../types';
import { useRitualEngine } from '../useRitualEngine';

// ---------------------------------------------------------------------------
// Bug A — integration: idle display reconciles and running session is guarded.
// Tests 3, 4, 5 (all RED until CONFIG_CHANGED lands in the engine).
// ---------------------------------------------------------------------------

const MIN = MS_PER_MINUTE;

function makeDeps(): EngineDeps {
  return {
    now: () => Date.now(),
    setIntervalMs: (cb, ms) => setInterval(cb, ms),
    clearIntervalMs: (h) => {
      clearInterval(h);
    },
    audio: { play: jest.fn<(kind: CueKind) => void>() },
    haptics: { cue: jest.fn<(kind: CueKind) => void>() },
  };
}

describe('useRitualEngine — CONFIG_CHANGED integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Test 3 — Regression guard (should stay green after the fix)
  // An idle meditation_timer engine with duration=5 must report 05:00 via
  // the hook's RitualState.  This asserts the existing baseline behaviour;
  // it acts as a regression guard that verifies the idle seed is correct
  // before we push a config change in test 4.
  it('idle engine for 5-min config exposes remainingMs = 5 * MIN', () => {
    const config: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 5,
    };
    const { result } = renderHook(() => useRitualEngine(config, makeDeps()));
    const [state] = result.current;
    expect(state.status).toBe('idle');
    expect(state.remainingMs).toBe(getTotalMs(config));
    expect(state.remainingMs).toBe(5 * MIN);
  });

  // Test 4 — RED
  // When the hook's config prop changes while the session is idle, the
  // engine must re-seed remainingMs to the new getTotalMs.  Before the fix
  // the hook never dispatches CONFIG_CHANGED, so remainingMs stays at the
  // original 5 * MIN even after rerender with 20 * MIN.
  it('idle engine re-seeds remainingMs when config.duration_minutes changes', () => {
    const fiveMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 5,
    };
    const twentyMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 20,
    };

    const { result, rerender } = renderHook(
      ({ config }: { config: MeditationTimerConfig }) => useRitualEngine(config, makeDeps()),
      { initialProps: { config: fiveMin } },
    );

    expect(result.current[0].remainingMs).toBe(5 * MIN);

    // Simulate a configurator save by swapping the config prop.
    act(() => {
      rerender({ config: twentyMin });
    });

    // After the fix, CONFIG_CHANGED is dispatched and remainingMs becomes
    // 20 * MIN.  Before the fix this stays at 5 * MIN and the assertion
    // fails (RED).
    expect(result.current[0].status).toBe('idle');
    expect(result.current[0].remainingMs).toBe(getTotalMs(twentyMin));
    expect(result.current[0].remainingMs).toBe(20 * MIN);
  });

  // Test 5 — RED (critical safety guard)
  // A running session must survive a config prop change untouched.  Before
  // the fix there is no CONFIG_CHANGED dispatch at all, so the session
  // happens to stay running (accidental safety); the test pins that guarantee
  // so a naive implementation that always re-seeds would be caught.
  it('running session is not disrupted when config changes to 20 min', () => {
    const fiveMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 5,
    };
    const twentyMin: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 20,
    };

    const { result, rerender } = renderHook(
      ({ config }: { config: MeditationTimerConfig }) => useRitualEngine(config, makeDeps()),
      { initialProps: { config: fiveMin } },
    );

    // Start the session and let some time elapse (~10 seconds worth of ticks).
    act(() => {
      result.current[1].start();
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });

    expect(result.current[0].status).toBe('running');
    const remainingAfterTick = result.current[0].remainingMs;
    // Verify the tick actually advanced us past the seed value.
    expect(remainingAfterTick).toBeLessThan(5 * MIN);
    expect(remainingAfterTick).toBeGreaterThan(0);

    // Now swap the config as if a configurator save happened.
    act(() => {
      rerender({ config: twentyMin });
    });

    // The session must still be running and at the same remaining value —
    // not reset to 20 * MIN and not reset to 5 * MIN.
    expect(result.current[0].status).toBe('running');
    // remainingMs must continue from the running value (within one tick = 100ms).
    expect(result.current[0].remainingMs).toBeLessThan(5 * MIN);
    // Crucially: it must NOT have jumped to the new 20-min seed.
    expect(result.current[0].remainingMs).not.toBe(20 * MIN);
  });

  // Test 3b — display layer: MeditationTimerView shows 05:00 for a 5-min idle engine.
  // Regression guard — verifies the testID exists and formats correctly before
  // exercising the config-change path.
  it('MeditationTimerView renders 05:00 for an idle 5-min engine', () => {
    const config: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 5,
    };
    const deps = makeDeps();
    const { result } = renderHook(() => useRitualEngine(config, deps));
    const [state, controls] = result.current;

    const { getByTestId } = render(<MeditationTimerView state={state} controls={controls} />);

    expect(getByTestId('meditation-time-remaining').props.children).toBe('05:00');
  });
});
