// Mirrors the backend `ModeConfig` Pydantic discriminated union (ritual-01);
// the runtime payload arrives as plain JSON, so we capture it here by shape.

export type EngineStatus = 'idle' | 'running' | 'paused' | 'complete';

export type CueKind =
  | 'start_bell'
  | 'halfway_bell'
  | 'end_bell'
  | 'interval_bell'
  | 'metronome_tick';

export interface Cue {
  readonly atMs: number;
  readonly kind: CueKind;
}

export interface MeditationTimerConfig {
  mode: 'meditation_timer';
  duration_minutes: number;
  start_bell?: boolean;
  halfway_bell?: boolean;
  end_bell?: boolean;
}

export interface CountUpConfig {
  mode: 'count_up';
  soft_cap_minutes?: number | null;
}

export interface MetronomeConfig {
  mode: 'metronome';
  bpm: number;
  timer: MeditationTimerConfig;
}

export type IntervalBellTone = 'bowl' | 'chime' | 'gong';

export interface IntervalBellConfig {
  mode: 'interval_bell';
  duration_minutes: number;
  interval_minutes?: number | null;
  cue_offsets_minutes?: readonly number[] | null;
  bell_tone: IntervalBellTone;
}

export interface RepCounterConfig {
  mode: 'rep_counter';
  target_reps: number;
  unit_label: string;
  time_cap_minutes?: number | null;
}

export type SenseKind = 'sight' | 'touch' | 'hearing' | 'smell' | 'taste';

export interface SensePrompt {
  sense: SenseKind;
  label: string;
}

export interface SenseGroundingConfig {
  mode: 'sense_grounding';
  prompts: readonly SensePrompt[];
}

export interface TarotConfig {
  mode: 'tarot';
  deck: 'major_arcana';
  per_card_minutes?: number;
  hide_timer_during_meditation?: boolean;
}

export type ModeConfig =
  | MeditationTimerConfig
  | CountUpConfig
  | MetronomeConfig
  | IntervalBellConfig
  | RepCounterConfig
  | SenseGroundingConfig
  | TarotConfig;

export interface RitualState {
  status: EngineStatus;
  elapsedMs: number;
  remainingMs: number | null;
  progress: number;
  repCount: number;
  currentStepIndex: number;
  nextCueAtMs: number | null;
  cuesStruck: number;
}

export interface RitualControls {
  start: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  complete: () => void;
  tap: () => void;
  advanceStep: () => void;
}

export interface AudioAdapter {
  play: (kind: CueKind) => void;
}

export interface HapticsAdapter {
  cue: (kind: CueKind) => void;
}

export type IntervalHandle = ReturnType<typeof setInterval>;

export interface EngineDeps {
  now?: () => number;
  setIntervalMs?: (cb: () => void, ms: number) => IntervalHandle;
  clearIntervalMs?: (h: IntervalHandle) => void;
  audio?: AudioAdapter;
  haptics?: HapticsAdapter;
  startCardIndex?: number;
}

export interface EngineState extends RitualState {
  startedAtMs: number | null;
  pauseStartedAtMs: number | null;
  pausedTotalMs: number;
  cueIndex: number;
  cues: readonly Cue[];
}

export type EngineAction =
  | { type: 'START'; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'CANCEL' }
  | { type: 'COMPLETE'; now: number }
  | { type: 'TICK'; now: number }
  | { type: 'TAP' }
  | { type: 'ADVANCE_STEP' };

export const TAROT_DECK_SIZE = 22;
