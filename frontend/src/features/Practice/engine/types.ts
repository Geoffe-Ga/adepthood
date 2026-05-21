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
 * One card in a `card_meditation` deck — bundled or user-curated.
 *
 * Mirrors the backend `CardMeditationCard`. `image_asset_key` and
 * `image_uri` are mutually exclusive: a card points at a bundled asset
 * *or* at a device-local file, never both. Both unset is valid for a
 * text-only card whose meaning rides on `name` and `symbolism`.
 */
export interface CardMeditationCard {
  name: string;
  /** Opaque handle resolved against a bundled deck manifest; null for device/text cards. */
  image_asset_key: string | null;
  /** Device-local URI (`file://`, `content://`, …); null for bundled/text cards. */
  image_uri: string | null;
  symbolism: string | null;
}

/**
 * Deck-agnostic card meditation — a bundled deck *or* user-curated cards.
 *
 * Mirrors the backend `CardMeditationConfig`. `deck_id` resolves a
 * bundled deck; the sentinel {@link CARD_MEDITATION_CUSTOM_DECK_ID}
 * signals a user-curated deck whose cards travel inline in `cards`.
 */
export interface CardMeditationConfig {
  mode: 'card_meditation';
  deck_id: string;
  per_card_minutes?: number;
  shuffle?: boolean;
  reveal_after_meditation?: boolean;
  /** View-layer only: suppress the countdown ring during the sit. No engine effect. */
  hide_timer_during_meditation?: boolean;
  cards?: readonly CardMeditationCard[] | null;
}

export type ModeConfig =
  | MeditationTimerConfig
  | CountUpConfig
  | MetronomeConfig
  | IntervalBellConfig
  | RepCounterConfig
  | SenseGroundingConfig
  | TarotConfig
  | CardMeditationConfig;

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

/** Default per-card sit length for `card_meditation`; mirrors the backend default. */
export const DEFAULT_CARD_MEDITATION_MINUTES = 5;
/** Sentinel `deck_id` for a user-curated deck whose cards travel inline in the config. */
export const CARD_MEDITATION_CUSTOM_DECK_ID = 'custom';
/** Upper bound on a custom deck's card count; mirrors the backend `CARD_MEDITATION_CARDS_MAX`. */
export const CARD_MEDITATION_CARDS_MAX = 200;
/** Maximum card-name length; mirrors the backend `CARD_NAME_MAX`. */
export const CARD_MEDITATION_NAME_MAX = 120;
/** Maximum card-symbolism length; mirrors the backend `_CARD_SYMBOLISM_MAX`. */
export const CARD_MEDITATION_SYMBOLISM_MAX = 500;
/** Deck-id slug pattern; mirrors the backend `CARD_DECK_ID_PATTERN`. */
export const CARD_DECK_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
