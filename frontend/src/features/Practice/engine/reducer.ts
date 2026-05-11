import { scheduledCues } from './cues';
import type {
  EngineAction,
  EngineState,
  ModeConfig,
  RepCounterConfig,
  SenseGroundingConfig,
} from './types';
import { DEFAULT_TAROT_MINUTES, MS_PER_MINUTE, TAROT_DECK_SIZE } from './types';

export function initialState(config: ModeConfig, startCardIndex = 0): EngineState {
  return {
    status: 'idle',
    elapsedMs: 0,
    remainingMs: getTotalMs(config),
    progress: 0,
    repCount: 0,
    currentStepIndex: config.mode === 'tarot' ? startCardIndex : 0,
    nextCueAtMs: null,
    cuesStruck: 0,
    startedAtMs: null,
    pauseStartedAtMs: null,
    pausedTotalMs: 0,
    cueIndex: 0,
    cues: [],
  };
}

export function ritualReducer(
  state: EngineState,
  action: EngineAction,
  config: ModeConfig,
): EngineState {
  switch (action.type) {
    case 'START':
      return handleStart(state, action.now, config);
    case 'PAUSE':
      return state.status === 'running'
        ? { ...state, status: 'paused', pauseStartedAtMs: action.now }
        : state;
    case 'RESUME':
      return handleResume(state, action.now);
    case 'CANCEL':
      return handleCancel(state, config);
    case 'COMPLETE':
      return handleComplete(state, action.now);
    case 'TICK':
      return handleTick(state, action.now, config);
    case 'TAP':
      return handleTap(state, config);
    case 'ADVANCE_STEP':
      return handleAdvanceStep(state, config);
  }
}

function handleStart(state: EngineState, now: number, config: ModeConfig): EngineState {
  const cues = scheduledCues(config);
  return advanceCues(
    {
      ...state,
      status: 'running',
      elapsedMs: 0,
      remainingMs: getTotalMs(config),
      progress: 0,
      repCount: 0,
      currentStepIndex: config.mode === 'tarot' ? state.currentStepIndex : 0,
      nextCueAtMs: cues[0]?.atMs ?? null,
      cuesStruck: 0,
      startedAtMs: now,
      pauseStartedAtMs: null,
      pausedTotalMs: 0,
      cueIndex: 0,
      cues,
    },
    0,
  );
}

function handleCancel(state: EngineState, config: ModeConfig): EngineState {
  if (state.status === 'idle') return state;
  return initialState(config, state.currentStepIndex);
}

function handleResume(state: EngineState, now: number): EngineState {
  if (state.status !== 'paused' || state.pauseStartedAtMs === null) return state;
  return {
    ...state,
    status: 'running',
    pauseStartedAtMs: null,
    pausedTotalMs: state.pausedTotalMs + (now - state.pauseStartedAtMs),
  };
}

function handleComplete(state: EngineState, now: number): EngineState {
  if (state.status === 'idle' || state.status === 'complete') return state;
  // Freeze elapsedMs from the wall clock; pause time is already excluded.
  const elapsedMs =
    state.status === 'running' && state.startedAtMs !== null
      ? now - state.startedAtMs - state.pausedTotalMs
      : state.elapsedMs;
  return { ...state, status: 'complete', elapsedMs };
}

function handleTick(state: EngineState, now: number, config: ModeConfig): EngineState {
  if (state.status !== 'running' || state.startedAtMs === null) return state;
  const elapsedMs = now - state.startedAtMs - state.pausedTotalMs;
  const totalMs = getTotalMs(config);
  const advanced = advanceCues(
    {
      ...state,
      elapsedMs,
      remainingMs: totalMs === null ? null : Math.max(0, totalMs - elapsedMs),
      progress: getProgress(state, config, elapsedMs),
    },
    elapsedMs,
  );
  return totalMs !== null && elapsedMs >= totalMs ? { ...advanced, status: 'complete' } : advanced;
}

function advanceCues(state: EngineState, elapsedMs: number): EngineState {
  let cueIndex = state.cueIndex;
  let cuesStruck = state.cuesStruck;
  while (cueIndex < state.cues.length) {
    const next = state.cues[cueIndex];
    if (!next || next.atMs > elapsedMs) break;
    cueIndex++;
    cuesStruck++;
  }
  return {
    ...state,
    cueIndex,
    cuesStruck,
    nextCueAtMs: state.cues[cueIndex]?.atMs ?? null,
  };
}

function handleTap(state: EngineState, config: ModeConfig): EngineState {
  if (state.status !== 'running') return state;
  if (config.mode === 'rep_counter') return tapRep(state, config);
  if (config.mode === 'sense_grounding') return advanceSense(state, config);
  return state;
}

function handleAdvanceStep(state: EngineState, config: ModeConfig): EngineState {
  if (state.status !== 'running') return state;
  if (config.mode === 'sense_grounding') return advanceSense(state, config);
  if (config.mode === 'tarot') {
    return { ...state, currentStepIndex: (state.currentStepIndex + 1) % TAROT_DECK_SIZE };
  }
  return state;
}

function tapRep(state: EngineState, config: RepCounterConfig): EngineState {
  const repCount = state.repCount + 1;
  const target = config.target_reps;
  return {
    ...state,
    repCount,
    progress: target > 0 ? Math.min(1, repCount / target) : 0,
    status: repCount >= target ? 'complete' : state.status,
  };
}

function advanceSense(state: EngineState, config: SenseGroundingConfig): EngineState {
  const idx = state.currentStepIndex + 1;
  const total = config.prompts.length;
  return {
    ...state,
    currentStepIndex: idx,
    progress: total > 0 ? Math.min(1, idx / total) : 0,
    status: idx >= total ? 'complete' : state.status,
  };
}

export function getTotalMs(config: ModeConfig): number | null {
  switch (config.mode) {
    case 'count_up':
    case 'sense_grounding':
      return null;
    case 'meditation_timer':
    case 'interval_bell':
      return config.duration_minutes * MS_PER_MINUTE;
    case 'metronome':
      return config.timer.duration_minutes * MS_PER_MINUTE;
    case 'tarot':
      return (config.per_card_minutes ?? DEFAULT_TAROT_MINUTES) * MS_PER_MINUTE;
    case 'rep_counter':
      return config.time_cap_minutes != null ? config.time_cap_minutes * MS_PER_MINUTE : null;
  }
}

function getProgress(state: EngineState, config: ModeConfig, elapsedMs: number): number {
  if (config.mode === 'count_up') return 0;
  if (config.mode === 'rep_counter') {
    return config.target_reps > 0 ? Math.min(1, state.repCount / config.target_reps) : 0;
  }
  if (config.mode === 'sense_grounding') {
    const total = config.prompts.length;
    return total > 0 ? Math.min(1, state.currentStepIndex / total) : 0;
  }
  const total = getTotalMs(config);
  return total !== null && total > 0 ? Math.min(1, elapsedMs / total) : 0;
}
