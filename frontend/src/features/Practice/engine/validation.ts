// Mirrors the backend Pydantic constraints from
// ``backend/src/schemas/practice_mode_config.py`` so the configurator UI
// can short-circuit save attempts that would round-trip to a 422.  Each
// per-mode validator returns a list of human-readable errors; an empty
// list means the payload is acceptable.

import type {
  CardMeditationCard,
  CardMeditationConfig,
  CountUpConfig,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  ModeConfig,
  RepCounterConfig,
  SenseGroundingConfig,
  SenseKind,
  SensePrompt,
  TarotConfig,
} from './types';
import {
  CARD_DECK_ID_PATTERN,
  CARD_MEDITATION_CARDS_MAX,
  CARD_MEDITATION_CUSTOM_DECK_ID,
  CARD_MEDITATION_NAME_MAX,
  CARD_MEDITATION_SYMBOLISM_MAX,
} from './types';

export const BPM_MIN = 20;
export const BPM_MAX = 240;
export const DURATION_MIN_MINUTES = 0.5;
export const DURATION_MAX_MINUTES = 24 * 60;
export const PROMPT_LABEL_MAX = 255;
export const UNIT_LABEL_MAX = 64;
export const TARGET_REPS_MIN = 1;
/** Mirrors the backend ``UserPractice.custom_name`` column (ritual-03). */
export const CUSTOM_NAME_MAX = 255;

export const ALLOWED_SENSES: readonly SenseKind[] = ['sight', 'touch', 'hearing', 'smell', 'taste'];

export const ALLOWED_BELL_TONES = ['bowl', 'chime', 'gong'] as const;

function pushIfOutOfDurationRange(
  errors: string[],
  field: string,
  value: number,
  min: number = DURATION_MIN_MINUTES,
): void {
  if (!Number.isFinite(value) || value < min || value > DURATION_MAX_MINUTES) {
    errors.push(`${field} must be between ${min} and ${DURATION_MAX_MINUTES} minutes`);
  }
}

export function validateMeditationTimer(config: MeditationTimerConfig): string[] {
  const errors: string[] = [];
  pushIfOutOfDurationRange(errors, 'Duration', config.duration_minutes);
  return errors;
}

export function validateCountUp(config: CountUpConfig): string[] {
  const errors: string[] = [];
  if (config.soft_cap_minutes !== undefined && config.soft_cap_minutes !== null) {
    pushIfOutOfDurationRange(errors, 'Soft cap', config.soft_cap_minutes);
  }
  return errors;
}

export function validateMetronome(config: MetronomeConfig): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(config.bpm) || config.bpm < BPM_MIN || config.bpm > BPM_MAX) {
    errors.push(`BPM must be between ${BPM_MIN} and ${BPM_MAX}`);
  }
  if (!Number.isInteger(config.bpm)) {
    errors.push('BPM must be a whole number');
  }
  errors.push(...validateMeditationTimer(config.timer));
  return errors;
}

function checkOffsetList(offsets: readonly number[], duration: number): string[] {
  const errors: string[] = [];
  if (offsets.length === 0) {
    errors.push('At least one cue offset is required');
  }
  for (const offset of offsets) {
    if (!Number.isFinite(offset) || offset <= 0 || offset > duration) {
      errors.push('Cue offsets must fall within (0, duration]');
      break;
    }
  }
  return errors;
}

function checkIntervalSpacing(interval: number, duration: number): string[] {
  if (!Number.isFinite(interval) || interval < DURATION_MIN_MINUTES) {
    return [`Interval must be at least ${DURATION_MIN_MINUTES} minute(s)`];
  }
  if (interval >= duration) {
    return ['Interval must be less than total duration'];
  }
  return [];
}

function checkBellTone(tone: IntervalBellConfig['bell_tone']): string[] {
  return ALLOWED_BELL_TONES.includes(tone) ? [] : ['Unknown bell tone'];
}

export function validateIntervalBell(config: IntervalBellConfig): string[] {
  const errors: string[] = [];
  pushIfOutOfDurationRange(errors, 'Duration', config.duration_minutes);
  const interval = config.interval_minutes ?? null;
  const offsets = config.cue_offsets_minutes ?? null;
  // The two spacing strategies are mutually exclusive (mirrors the Pydantic
  // model_validator in ``backend/src/schemas/practice_mode_config.py``).
  // Split the two violation classes so the surfaced error tells the user
  // which side of the constraint they tripped.
  if (interval === null && offsets === null) {
    errors.push('Select a spacing method: even intervals or custom offsets');
    return errors;
  }
  if (interval !== null && offsets !== null) {
    errors.push('Choose either even intervals or custom offsets, not both');
    return errors;
  }
  if (interval !== null) {
    errors.push(...checkIntervalSpacing(interval, config.duration_minutes));
  } else if (offsets !== null) {
    errors.push(...checkOffsetList(offsets, config.duration_minutes));
  }
  errors.push(...checkBellTone(config.bell_tone));
  return errors;
}

export function validateRepCounter(config: RepCounterConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.target_reps) || config.target_reps < TARGET_REPS_MIN) {
    errors.push(`Target reps must be a whole number ≥ ${TARGET_REPS_MIN}`);
  }
  if (config.unit_label.trim().length === 0) {
    errors.push('Unit label cannot be empty');
  }
  if (config.unit_label.length > UNIT_LABEL_MAX) {
    errors.push(`Unit label must be ≤ ${UNIT_LABEL_MAX} characters`);
  }
  if (config.time_cap_minutes !== undefined && config.time_cap_minutes !== null) {
    pushIfOutOfDurationRange(errors, 'Time cap', config.time_cap_minutes);
  }
  return errors;
}

function checkPrompt(prompt: SensePrompt, index: number): string[] {
  const errors: string[] = [];
  if (!ALLOWED_SENSES.includes(prompt.sense)) {
    errors.push(`Prompt ${index + 1}: unknown sense`);
  }
  const labelLen = prompt.label.trim().length;
  if (labelLen === 0) {
    errors.push(`Prompt ${index + 1}: label cannot be empty`);
  }
  if (prompt.label.length > PROMPT_LABEL_MAX) {
    errors.push(`Prompt ${index + 1}: label must be ≤ ${PROMPT_LABEL_MAX} characters`);
  }
  return errors;
}

export function validateSenseGrounding(config: SenseGroundingConfig): string[] {
  const errors: string[] = [];
  if (config.prompts.length === 0) {
    errors.push('At least one sense prompt is required');
    return errors;
  }
  config.prompts.forEach((prompt, index) => {
    errors.push(...checkPrompt(prompt, index));
  });
  return errors;
}

export function validateTarot(config: TarotConfig): string[] {
  const errors: string[] = [];
  if (config.per_card_minutes !== undefined) {
    pushIfOutOfDurationRange(errors, 'Per-card minutes', config.per_card_minutes);
  }
  return errors;
}

function checkCard(card: CardMeditationCard, index: number): string[] {
  const errors: string[] = [];
  const position = `Card ${index + 1}`;
  if (card.name.trim().length === 0) {
    errors.push(`${position}: name cannot be empty`);
  }
  if (card.name.length > CARD_MEDITATION_NAME_MAX) {
    errors.push(`${position}: name must be ≤ ${CARD_MEDITATION_NAME_MAX} characters`);
  }
  if (card.image_asset_key !== null && card.image_uri !== null) {
    errors.push(`${position}: set at most one image source`);
  }
  if (card.symbolism !== null && card.symbolism.length > CARD_MEDITATION_SYMBOLISM_MAX) {
    errors.push(`${position}: symbolism must be ≤ ${CARD_MEDITATION_SYMBOLISM_MAX} characters`);
  }
  return errors;
}

export function validateCardMeditation(config: CardMeditationConfig): string[] {
  const errors: string[] = [];
  if (config.per_card_minutes !== undefined) {
    pushIfOutOfDurationRange(errors, 'Per-card minutes', config.per_card_minutes);
  }
  if (!CARD_DECK_ID_PATTERN.test(config.deck_id)) {
    errors.push('Deck id is invalid');
  }
  if (config.deck_id === CARD_MEDITATION_CUSTOM_DECK_ID) {
    const cards = config.cards ?? [];
    if (cards.length === 0) {
      errors.push('Add at least one card to use a custom deck');
      return errors;
    }
    if (cards.length > CARD_MEDITATION_CARDS_MAX) {
      errors.push(`A custom deck can hold at most ${CARD_MEDITATION_CARDS_MAX} cards`);
    }
    cards.forEach((card, index) => {
      errors.push(...checkCard(card, index));
    });
  }
  return errors;
}

const VALIDATORS: {
  [K in ModeConfig['mode']]: (config: Extract<ModeConfig, { mode: K }>) => string[];
} = {
  meditation_timer: validateMeditationTimer,
  count_up: validateCountUp,
  metronome: validateMetronome,
  interval_bell: validateIntervalBell,
  rep_counter: validateRepCounter,
  sense_grounding: validateSenseGrounding,
  tarot: validateTarot,
  card_meditation: validateCardMeditation,
};

/**
 * Validate the user-supplied ``custom_name`` override.  Trimmed length must
 * be non-empty; raw length is capped at :data:`CUSTOM_NAME_MAX` to match the
 * ``UserPractice.custom_name`` column added in ritual-03.
 */
export function validateCustomName(name: string): string[] {
  const errors: string[] = [];
  if (name.trim().length === 0) {
    errors.push('Name cannot be empty');
  }
  if (name.length > CUSTOM_NAME_MAX) {
    errors.push(`Name must be ≤ ${CUSTOM_NAME_MAX} characters`);
  }
  return errors;
}

export function validateModeConfig(config: ModeConfig): string[] {
  // The mapped-type ``VALIDATORS`` table guarantees every mode has a
  // validator. The double cast narrows the union per-mode without an
  // ``as`` chain at every call site. Unknown discriminators (e.g. a
  // newer server-side mode the client doesn't yet recognise) skip
  // validation here -- the configurator renders an "unsupported mode"
  // notice instead of attempting to edit.
  type AnyValidator = (config: ModeConfig) => string[];
  const validator = VALIDATORS[config.mode] as AnyValidator | undefined;
  return validator ? validator(config) : [];
}
