/**
 * Smart defaults for every supported ``ModeConfig`` discriminator
 * (custom-practices-07).
 *
 * The Create Practice wizard pre-fills these so a user can land on the
 * configurator step, accept the defaults, name the practice, and submit
 * a server-valid payload without touching a single field. Each default
 * sits inside its mode's validation window (see
 * ``features/Practice/engine/validation``) so a wizard submission cannot
 * round-trip to a 422.
 */

import type {
  CardMeditationConfig,
  CountUpConfig,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  RandomIntervalBellConfig,
  RepCounterConfig,
  SenseGroundingConfig,
  TalliedGroundingConfig,
  TarotConfig,
} from '../engine/types';

const DEFAULT_DURATION_MINUTES = 10;
const DEFAULT_METRONOME_BPM = 60;
const DEFAULT_INTERVAL_BELL_INTERVAL = 5;
const DEFAULT_RANDOM_BELL_MIN_SECONDS = 30;
const DEFAULT_RANDOM_BELL_MAX_SECONDS = 180;
const DEFAULT_REP_TARGET = 10;
const DEFAULT_TALLIED_ROUNDS = 3;
const DEFAULT_TALLIED_TARGET = 3;

const DEFAULT_SENSE_PROMPTS: SenseGroundingConfig['prompts'] = [
  { sense: 'sight', label: 'something blue' },
  { sense: 'touch', label: 'a smooth texture' },
  { sense: 'hearing', label: 'a faraway sound' },
];

const DEFAULT_TALLIED_CATEGORIES: TalliedGroundingConfig['categories'] = [
  { key: 'circle', label: 'a circle', target_count: DEFAULT_TALLIED_TARGET },
  { key: 'square', label: 'a square', target_count: DEFAULT_TALLIED_TARGET },
  { key: 'triangle', label: 'a triangle', target_count: DEFAULT_TALLIED_TARGET },
];

const DEFAULTS: { [K in ModeConfig['mode']]: () => Extract<ModeConfig, { mode: K }> } = {
  meditation_timer: (): MeditationTimerConfig => ({
    mode: 'meditation_timer',
    duration_minutes: DEFAULT_DURATION_MINUTES,
    start_bell: true,
    halfway_bell: false,
    end_bell: true,
  }),
  count_up: (): CountUpConfig => ({ mode: 'count_up' }),
  metronome: (): MetronomeConfig => ({
    mode: 'metronome',
    bpm: DEFAULT_METRONOME_BPM,
    timer: {
      mode: 'meditation_timer',
      duration_minutes: DEFAULT_DURATION_MINUTES,
      start_bell: true,
      end_bell: true,
    },
  }),
  interval_bell: (): IntervalBellConfig => ({
    mode: 'interval_bell',
    duration_minutes: DEFAULT_DURATION_MINUTES * 2,
    interval_minutes: DEFAULT_INTERVAL_BELL_INTERVAL,
    bell_tone: 'bowl',
  }),
  random_interval_bell: (): RandomIntervalBellConfig => ({
    mode: 'random_interval_bell',
    duration_minutes: DEFAULT_DURATION_MINUTES * 2,
    min_interval_seconds: DEFAULT_RANDOM_BELL_MIN_SECONDS,
    max_interval_seconds: DEFAULT_RANDOM_BELL_MAX_SECONDS,
    bell_tone: 'bowl',
  }),
  rep_counter: (): RepCounterConfig => ({
    mode: 'rep_counter',
    target_reps: DEFAULT_REP_TARGET,
    unit_label: 'reps',
  }),
  sense_grounding: (): SenseGroundingConfig => ({
    mode: 'sense_grounding',
    prompts: DEFAULT_SENSE_PROMPTS,
  }),
  tallied_grounding: (): TalliedGroundingConfig => ({
    mode: 'tallied_grounding',
    rounds: DEFAULT_TALLIED_ROUNDS,
    categories: DEFAULT_TALLIED_CATEGORIES,
  }),
  tarot: (): TarotConfig => ({ mode: 'tarot', deck: 'major_arcana' }),
  card_meditation: (): CardMeditationConfig => ({
    mode: 'card_meditation',
    deck_id: 'rws',
  }),
};

/**
 * Build a server-valid default ``ModeConfig`` for the requested mode.
 *
 * Returned values are fresh objects on every call so the wizard's edit
 * state can mutate them with ``setConfig`` without disturbing the
 * shared defaults table.
 */
export function defaultConfigFor<M extends ModeConfig['mode']>(
  mode: M,
): Extract<ModeConfig, { mode: M }> {
  return DEFAULTS[mode]();
}

const DURATION_HINTS: {
  [K in ModeConfig['mode']]: (config: Extract<ModeConfig, { mode: K }>) => number;
} = {
  meditation_timer: (c) => c.duration_minutes,
  interval_bell: (c) => c.duration_minutes,
  random_interval_bell: (c) => c.duration_minutes,
  metronome: (c) => c.timer.duration_minutes,
  tarot: (c) => c.per_card_minutes ?? DEFAULT_DURATION_MINUTES / 2,
  card_meditation: (c) => c.per_card_minutes ?? DEFAULT_DURATION_MINUTES / 2,
  count_up: () => DEFAULT_DURATION_MINUTES,
  rep_counter: () => DEFAULT_DURATION_MINUTES,
  sense_grounding: () => DEFAULT_DURATION_MINUTES,
  tallied_grounding: () => DEFAULT_DURATION_MINUTES,
};

/**
 * Heuristic duration in minutes for the metadata step's auto-suggest.
 *
 * Modes without an inherent duration (``count_up``, ``rep_counter``,
 * ``sense_grounding``, ``tallied_grounding``) fall back to a single
 * shared default so the field is never blank.
 */
export function suggestedDurationFor(config: ModeConfig): number {
  type AnyHint = (config: ModeConfig) => number;
  const hint = DURATION_HINTS[config.mode] as AnyHint;
  return Math.max(1, Math.round(hint(config)));
}
