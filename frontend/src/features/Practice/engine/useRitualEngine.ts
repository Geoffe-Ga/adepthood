import type { Dispatch, MutableRefObject } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { initialState, ritualReducer } from './reducer';
import type {
  AudioAdapter,
  EngineAction,
  EngineDeps,
  EngineState,
  HapticsAdapter,
  IntervalHandle,
  ModeConfig,
  RitualControls,
  RitualState,
} from './types';

// 100ms tick: smooth countdown ring without burning CPU.
const TICK_INTERVAL_MS = 100;

interface ResolvedDeps {
  now: () => number;
  setIntervalMs: (cb: () => void, ms: number) => IntervalHandle;
  clearIntervalMs: (h: IntervalHandle) => void;
  audio: AudioAdapter;
  haptics: HapticsAdapter;
}

const NOOP_AUDIO: AudioAdapter = { play: () => undefined };
const NOOP_HAPTICS: HapticsAdapter = { cue: () => undefined };

function resolveDeps(deps: EngineDeps): ResolvedDeps {
  return {
    now: deps.now ?? Date.now,
    setIntervalMs: deps.setIntervalMs ?? ((cb, ms): IntervalHandle => setInterval(cb, ms)),
    clearIntervalMs: deps.clearIntervalMs ?? clearInterval,
    audio: deps.audio ?? NOOP_AUDIO,
    haptics: deps.haptics ?? NOOP_HAPTICS,
  };
}

function pickPublic(state: EngineState): RitualState {
  return {
    status: state.status,
    elapsedMs: state.elapsedMs,
    remainingMs: state.remainingMs,
    progress: state.progress,
    repCount: state.repCount,
    currentStepIndex: state.currentStepIndex,
    nextCueAtMs: state.nextCueAtMs,
    cuesStruck: state.cuesStruck,
  };
}

function buildControls(
  dispatch: Dispatch<EngineAction>,
  depsRef: MutableRefObject<ResolvedDeps>,
): RitualControls {
  return {
    start: () => dispatch({ type: 'START', now: depsRef.current.now() }),
    pause: () => dispatch({ type: 'PAUSE', now: depsRef.current.now() }),
    resume: () => dispatch({ type: 'RESUME', now: depsRef.current.now() }),
    cancel: () => dispatch({ type: 'CANCEL' }),
    complete: () => dispatch({ type: 'COMPLETE', now: depsRef.current.now() }),
    tap: () => dispatch({ type: 'TAP' }),
    advanceStep: () => dispatch({ type: 'ADVANCE_STEP' }),
  };
}

/**
 * Drives the ritual state machine for a given preset config.
 *
 * Caller contract: `config` must be a stable reference for the lifetime of
 * a session. The reducer captures it in a closure; the cue list and the
 * elapsedMs anchor are built once at START. Changing `config` mid-session
 * leaves the `state.cues` schedule from the old config in place while new
 * TICKs are scored against the new `getTotalMs(config)` — call
 * `controls.cancel()` first, then re-render with the new config and call
 * `controls.start()` again.
 */
export function useRitualEngine(
  config: ModeConfig,
  deps: EngineDeps = {},
): readonly [RitualState, RitualControls] {
  // Adapters are read through a ref so the ticker effect doesn't restart
  // every render when callers pass fresh function references.
  const depsRef = useRef<ResolvedDeps>(resolveDeps(deps));
  depsRef.current = resolveDeps(deps);

  const reducer = useCallback(
    (s: EngineState, a: EngineAction) => ritualReducer(s, a, config),
    [config],
  );
  const [state, dispatch] = useReducer(reducer, deps.startCardIndex ?? 0, (idx) =>
    initialState(config, idx),
  );

  const prevCueIndexRef = useRef(0);
  const prevCuesRef = useRef(state.cues);
  useEffect(() => {
    // A new `state.cues` reference means the reducer rebuilt the schedule
    // (START or CANCEL). Reset the high-water mark so the next session's
    // start_bell isn't suppressed by the prior session's final index.
    if (state.cues !== prevCuesRef.current) {
      prevCueIndexRef.current = 0;
      prevCuesRef.current = state.cues;
    }
    const prev = prevCueIndexRef.current;
    if (state.cueIndex > prev) {
      const { audio, haptics } = depsRef.current;
      for (let i = prev; i < state.cueIndex; i++) {
        const cue = state.cues[i];
        if (!cue) continue;
        audio.play(cue.kind);
        haptics.cue(cue.kind);
      }
    }
    prevCueIndexRef.current = state.cueIndex;
  }, [state.cueIndex, state.cues]);

  useEffect(() => {
    if (state.status !== 'running') return;
    const { setIntervalMs, clearIntervalMs, now } = depsRef.current;
    const handle = setIntervalMs(() => {
      dispatch({ type: 'TICK', now: now() });
    }, TICK_INTERVAL_MS);
    return () => {
      clearIntervalMs(handle);
    };
  }, [state.status]);

  const controls = useMemo<RitualControls>(() => buildControls(dispatch, depsRef), []);
  return [pickPublic(state), controls] as const;
}
