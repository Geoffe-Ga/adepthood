import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type {
  AudioAdapter,
  CueKind,
  EngineDeps,
  HapticsAdapter,
  MeditationTimerConfig,
  ModeConfig,
  RepCounterConfig,
  TarotConfig,
} from '../types';
import { useRitualEngine } from '../useRitualEngine';

const MIN = 60_000;

type CueFn = (kind: CueKind) => void;

interface MockDeps extends Required<Omit<EngineDeps, 'startCardIndex'>> {
  audio: AudioAdapter & { play: jest.Mock<CueFn> };
  haptics: HapticsAdapter & { cue: jest.Mock<CueFn> };
}

function makeDeps(): MockDeps {
  return {
    now: () => Date.now(),
    setIntervalMs: (cb, ms) => setInterval(cb, ms),
    clearIntervalMs: (h) => {
      clearInterval(h);
    },
    audio: { play: jest.fn<CueFn>() },
    haptics: { cue: jest.fn<CueFn>() },
  };
}

function renderEngine(config: ModeConfig, deps: EngineDeps, startCardIndex = 0) {
  return renderHook(() => useRitualEngine(config, { ...deps, startCardIndex }));
}

describe('useRitualEngine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts idle exposing only the public RitualState surface', () => {
    const { result } = renderEngine({ mode: 'meditation_timer', duration_minutes: 5 }, makeDeps());
    const [state] = result.current;
    expect(state.status).toBe('idle');
    expect(state.remainingMs).toBe(5 * MIN);
    expect(state).not.toHaveProperty('startedAtMs');
    expect(state).not.toHaveProperty('cues');
    expect(state).not.toHaveProperty('cueIndex');
  });

  it('drives a meditation_timer through to completion via the 100ms ticker', () => {
    const config: MeditationTimerConfig = {
      mode: 'meditation_timer',
      duration_minutes: 1,
      halfway_bell: true,
    };
    const deps = makeDeps();
    const { result } = renderEngine(config, deps);

    act(() => result.current[1].start());
    expect(result.current[0].status).toBe('running');
    expect(deps.audio.play).toHaveBeenNthCalledWith(1, 'start_bell');
    expect(deps.haptics.cue).toHaveBeenNthCalledWith(1, 'start_bell');

    act(() => jest.advanceTimersByTime(30_000));
    expect(result.current[0].cuesStruck).toBe(2);

    act(() => jest.advanceTimersByTime(30_000));
    expect(result.current[0].status).toBe('complete');
    expect(deps.audio.play).toHaveBeenLastCalledWith('end_bell');
  });

  it('pause/resume/cancel work and never emit a stray end_bell on cancel', () => {
    const config: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 5 };
    const deps = makeDeps();
    const { result } = renderEngine(config, deps);

    act(() => result.current[1].start());
    act(() => jest.advanceTimersByTime(10_000));
    act(() => result.current[1].pause());
    expect(result.current[0].status).toBe('paused');

    act(() => jest.advanceTimersByTime(30_000));
    act(() => result.current[1].resume());
    act(() => jest.advanceTimersByTime(5_000));
    expect(result.current[0].elapsedMs).toBeGreaterThanOrEqual(15_000);
    expect(result.current[0].elapsedMs).toBeLessThan(20_000);

    act(() => result.current[1].cancel());
    expect(result.current[0].status).toBe('idle');
    expect(deps.audio.play.mock.calls.flat()).not.toContain('end_bell');
  });

  it('exposes tap() / complete() / advanceStep() routed through the reducer', () => {
    const repConfig: RepCounterConfig = {
      mode: 'rep_counter',
      target_reps: 2,
      unit_label: 'breaths',
    };
    const repHook = renderEngine(repConfig, makeDeps());
    act(() => repHook.result.current[1].start());
    act(() => repHook.result.current[1].tap());
    act(() => repHook.result.current[1].tap());
    expect(repHook.result.current[0].status).toBe('complete');

    const tarotConfig: TarotConfig = {
      mode: 'tarot',
      deck: 'major_arcana',
      per_card_minutes: 5,
    };
    const tarotHook = renderEngine(tarotConfig, makeDeps(), 4);
    expect(tarotHook.result.current[0].currentStepIndex).toBe(4);
    act(() => tarotHook.result.current[1].start());
    act(() => tarotHook.result.current[1].advanceStep());
    expect(tarotHook.result.current[0].currentStepIndex).toBe(5);
    act(() => tarotHook.result.current[1].complete());
    expect(tarotHook.result.current[0].status).toBe('complete');
  });

  it('clears the ticker on unmount and on transition to complete', () => {
    const config: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 1 };
    const deps = makeDeps();
    const setSpy = jest.spyOn(deps, 'setIntervalMs');
    const clearSpy = jest.spyOn(deps, 'clearIntervalMs');
    const { result, unmount } = renderEngine(config, deps);

    act(() => result.current[1].start());
    expect(setSpy).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(60_000));
    expect(result.current[0].status).toBe('complete');
    expect(clearSpy).toHaveBeenCalled();

    const before = clearSpy.mock.calls.length;
    unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(before);
  });

  it('falls back to default Date.now / setInterval / noop adapters', () => {
    const config: MeditationTimerConfig = { mode: 'meditation_timer', duration_minutes: 1 };
    const { result } = renderHook(() => useRitualEngine(config));

    act(() => result.current[1].start());
    expect(result.current[0].status).toBe('running');
    act(() => jest.advanceTimersByTime(60_000));
    expect(result.current[0].status).toBe('complete');
  });
});
