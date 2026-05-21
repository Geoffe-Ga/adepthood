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
  /** View-layer only: nudge copy after this much elapsed time. No engine effect. */
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
  /** View-layer only: suppress the countdown ring during the sit. No engine effect. */
  hide_timer_during_meditation?: boolean;
}

/**
 * One category in a tallied-grounding round. `key` is the machine slug
 * used for analytics; `label` is the display string and is expected to
 * carry its own article (e.g. `"a square"`) so the view can render
 * `Find {label}` directly. Mirrors the backend `TalliedCategory`.
 */
export interface TalliedCategory {
  key: string;
  label: string;
  target_count: number;
}

/**
 * Rounds-by-categories-by-target-count shape shared by Find Shapes and
 * Find Colors. Total steps = `rounds × sum(category.target_count)`; the
 * view derives `(round, category, item)` from the linear
 * `currentStepIndex`. Mirrors the backend `TalliedGroundingConfig`.
 */
export interface TalliedGroundingConfig {
  mode: 'tallied_grounding';
  rounds: number;
  categories: readonly TalliedCategory[];
}

export type ModeConfig =
  | MeditationTimerConfig
  | CountUpConfig
  | MetronomeConfig
  | IntervalBellConfig
  | RepCounterConfig
  | SenseGroundingConfig
  | TalliedGroundingConfig
  | TarotConfig;

/**
 * Per-session metadata emitted when a tallied-grounding ritual completes.
 * Mirrors the backend `TalliedGroundingMetadata`; `rounds_completed` never
 * exceeds `total_rounds`.
 */
export interface TalliedGroundingMetadata {
  mode: 'tallied_grounding';
  rounds_completed: number;
  total_rounds: number;
  items_completed: number;
}

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
  play: (kind: CueKind) => void | Promise<void>;
  /** Free any loaded sound resources. Optional; safe to omit for no-op adapters. */
  dispose?: () => void;
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

export const MS_PER_MINUTE = 60_000;
export const DEFAULT_TAROT_MINUTES = 5;
/** 22 cards in a major arcana deck; tarot's cycle wraps modulo this. */
export const TAROT_DECK_SIZE = 22;
