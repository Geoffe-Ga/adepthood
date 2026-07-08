import type { SessionMetadata } from '@/api';
import type { PickedCard } from '@/features/Practice/data/resolveCard';
import { buildCardMeditationMetadata, pickCard } from '@/features/Practice/data/resolveCard';
import { cardForDayIndex } from '@/features/Practice/data/tarot';
import { scheduledCues } from '@/features/Practice/engine/cues';
import { totalSteps, totalStepsPerRound } from '@/features/Practice/engine/tallied';
import type {
  CardMeditationConfig,
  IntervalBellConfig,
  MindfulAnchorMetadata,
  ModeConfig,
  RandomIntervalBellMetadata,
  RepCounterConfig,
  RitualState,
  SenseGroundingConfig,
  TalliedGroundingConfig,
} from '@/features/Practice/engine/types';
import type { ModeSummaryMetadata } from '@/features/Practice/insights/format';
import { MS_PER_DAY } from '@/utils/dateUtils';

const TAROT_DECK_SIZE = 22;

/**
 * Calendar days between `startDateKey` (YYYY-MM-DD in the user's local TZ,
 * stored by the backend at signup) and today in the same TZ. The result
 * indexes into the major-arcana cycle (mod 22) so each new local-midnight
 * advances the card. Negative values are clamped to 0 so a future
 * `start_date` (clock skew) shows the Fool rather than wrapping backwards.
 */
export function daysSinceStart(startDateKey: string, tz: string): number {
  const today = todayDayKey(tz);
  const todayMs = parseDayKeyMs(today);
  const startMs = parseDayKeyMs(startDateKey);
  if (todayMs === null || startMs === null) return 0;
  const diff = Math.floor((todayMs - startMs) / MS_PER_DAY);
  return Math.max(0, diff);
}

function todayDayKey(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  }
}

function parseDayKeyMs(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/**
 * Wire-format metadata stripped of presentation-only extras (e.g.
 * `unit_label`, `card_name` from `ModeSummaryMetadata`). The backend
 * validates this discriminator against the resolved practice mode and
 * returns 400 ``mode_metadata_mismatch`` otherwise.
 *
 * Exported for unit testing the per-mode harvest branches.
 */
export function harvestMetadata(
  config: ModeConfig,
  state: RitualState,
  cardPick: PickedCard | null,
  randomBellMetadata: RandomIntervalBellMetadata | null = null,
  mindfulAnchorMeta: MindfulAnchorMetadata | null = null,
): SessionMetadata {
  // `random_interval_bell` schedule is view-owned, so harvest from the lifted metadata.
  if (config.mode === 'random_interval_bell') {
    return (
      randomBellMetadata ?? { mode: 'random_interval_bell', bells_struck: 0, interval_seconds: [] }
    );
  }
  return harvestEngineMetadata(config, state, cardPick, mindfulAnchorMeta);
}

type EngineMetadataConfig = Exclude<ModeConfig, { mode: 'random_interval_bell' }>;

/**
 * Pre-save fallback for the `mindful_anchor` harvest. `wireMetadata` is
 * recomputed on every render but only consumed once the engine reaches
 * `complete` — by which point the view has run its `onComplete` callback
 * and populated `mindfulAnchorMeta`. This object satisfies the return
 * type for the pre-save renders whose result is never read.
 */
const MINDFUL_ANCHOR_PRESAVE_FALLBACK: Extract<SessionMetadata, { mode: 'mindful_anchor' }> = {
  mode: 'mindful_anchor',
  chosen_option_key: null,
  duration_seconds: 0,
  met_min_duration: false,
};

/** Per-mode wire-metadata harvesters; the mapped type enforces exhaustive coverage. */
const ENGINE_METADATA_HARVESTERS: {
  [K in EngineMetadataConfig['mode']]: (
    config: Extract<EngineMetadataConfig, { mode: K }>,
    state: RitualState,
    cardPick: PickedCard | null,
    mindfulAnchorMeta: MindfulAnchorMetadata | null,
  ) => SessionMetadata;
} = {
  meditation_timer: () => ({ mode: 'meditation_timer' }),
  count_up: () => ({ mode: 'count_up' }),
  metronome: (config) => ({ mode: 'metronome', bpm_used: config.bpm }),
  interval_bell: harvestIntervalBell,
  rep_counter: (_config, state) => ({ mode: 'rep_counter', rep_count: state.repCount }),
  sense_grounding: harvestSenseGrounding,
  tallied_grounding: harvestTalliedGrounding,
  tarot: (_config, state) => ({
    mode: 'tarot',
    card_index: normalizeTarotIndex(state.currentStepIndex),
  }),
  card_meditation: (config, _state, cardPick) => cardMeditationWireMetadata(config, cardPick),
  mindful_anchor: (_config, _state, _cardPick, meta) => meta ?? MINDFUL_ANCHOR_PRESAVE_FALLBACK,
};

function harvestEngineMetadata(
  config: EngineMetadataConfig,
  state: RitualState,
  cardPick: PickedCard | null,
  mindfulAnchorMeta: MindfulAnchorMetadata | null,
): SessionMetadata {
  type AnyHarvester = (
    config: EngineMetadataConfig,
    state: RitualState,
    cardPick: PickedCard | null,
    mindfulAnchorMeta: MindfulAnchorMetadata | null,
  ) => SessionMetadata;
  return (ENGINE_METADATA_HARVESTERS[config.mode] as AnyHarvester)(
    config,
    state,
    cardPick,
    mindfulAnchorMeta,
  );
}

/**
 * Wire metadata for a `card_meditation` session. `cardPick` is resolved
 * once in `useActiveSession`; the fallback only guards a direct call
 * without a pre-resolved draw.
 */
function cardMeditationWireMetadata(
  config: CardMeditationConfig,
  cardPick: PickedCard | null,
): SessionMetadata {
  return buildCardMeditationMetadata(config, cardPick ?? pickCard(config));
}

/**
 * Tallied-grounding wire metadata. `items_completed` is the linear tap
 * count clamped to the ritual total; `rounds_completed` is how many full
 * rounds those taps covered. The summary metadata reuses this shape
 * verbatim — there are no presentation-only extras.
 */
function harvestTalliedGrounding(
  config: TalliedGroundingConfig,
  state: RitualState,
): Extract<SessionMetadata, { mode: 'tallied_grounding' }> {
  const perRound = totalStepsPerRound(config);
  const itemsCompleted = Math.min(state.currentStepIndex, totalSteps(config));
  return {
    mode: 'tallied_grounding',
    rounds_completed: perRound > 0 ? Math.floor(itemsCompleted / perRound) : 0,
    total_rounds: config.rounds,
    items_completed: itemsCompleted,
  };
}

function harvestIntervalBell(config: IntervalBellConfig, state: RitualState): SessionMetadata {
  const intervalCues = scheduledCues(config).filter((c) => c.kind === 'interval_bell');
  const struck = intervalCues.filter((c) => c.atMs <= state.elapsedMs).length;
  return {
    mode: 'interval_bell',
    intervals_struck: struck,
    total_intervals: intervalCues.length,
  };
}

function harvestSenseGrounding(config: SenseGroundingConfig, state: RitualState): SessionMetadata {
  const completed = config.prompts
    .slice(0, Math.min(state.currentStepIndex, config.prompts.length))
    .map((p) => p.sense);
  return { mode: 'sense_grounding', senses_completed: completed };
}

function normalizeTarotIndex(index: number): number {
  return ((index % TAROT_DECK_SIZE) + TAROT_DECK_SIZE) % TAROT_DECK_SIZE;
}

/**
 * Presentation-layer metadata for the ritual-12 `InsightCaptureModal`
 * summary. Carries the same fields as the wire `SessionMetadata` plus
 * presentation-only extras (`unit_label`, `card_name`) the formatter needs.
 *
 * Exported for unit testing the per-mode harvest branches.
 */
export function harvestSummaryMetadata(
  config: ModeConfig,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
  randomBellMetadata: RandomIntervalBellMetadata | null = null,
): ModeSummaryMetadata {
  if (config.mode === 'random_interval_bell') {
    return { mode: 'random_interval_bell', bells_struck: randomBellMetadata?.bells_struck ?? 0 };
  }
  return harvestEngineSummary(config, state, tarotCardIndex, cardPick);
}

function summarizeIntervalBell(
  config: IntervalBellConfig,
  state: RitualState,
): ModeSummaryMetadata {
  const wire = harvestIntervalBell(config, state) as Extract<
    SessionMetadata,
    { mode: 'interval_bell' }
  >;
  return {
    mode: 'interval_bell',
    intervals_struck: wire.intervals_struck,
    total_intervals: wire.total_intervals,
  };
}

function summarizeSenseGrounding(
  config: SenseGroundingConfig,
  state: RitualState,
): ModeSummaryMetadata {
  const wire = harvestSenseGrounding(config, state) as Extract<
    SessionMetadata,
    { mode: 'sense_grounding' }
  >;
  return { mode: 'sense_grounding', senses_completed: wire.senses_completed };
}

function summarizeTarot(_state: RitualState, tarotCardIndex: number): ModeSummaryMetadata {
  const idx = normalizeTarotIndex(tarotCardIndex);
  return { mode: 'tarot', card_index: idx, card_name: cardForDayIndex(idx).name };
}

function summarizeCardMeditation(
  config: CardMeditationConfig,
  state: RitualState,
  cardPick: PickedCard | null,
): ModeSummaryMetadata {
  // Reuse the wire harvest (and its single card draw) rather than drawing
  // the card a second time — mirrors the `interval_bell` reuse above.
  const wire = harvestMetadata(config, state, cardPick) as Extract<
    SessionMetadata,
    { mode: 'card_meditation' }
  >;
  return { mode: 'card_meditation', deck_id: wire.deck_id, card_name: wire.card_drawn_name };
}

/** Per-mode summary-metadata harvesters; the mapped type enforces exhaustive coverage. */
const ENGINE_SUMMARY_HARVESTERS: {
  [K in EngineMetadataConfig['mode']]: (
    config: Extract<EngineMetadataConfig, { mode: K }>,
    state: RitualState,
    tarotCardIndex: number,
    cardPick: PickedCard | null,
  ) => ModeSummaryMetadata;
} = {
  meditation_timer: () => ({ mode: 'meditation_timer' }),
  count_up: () => ({ mode: 'count_up' }),
  metronome: (config) => ({ mode: 'metronome', bpm_used: config.bpm }),
  interval_bell: (config, state) => summarizeIntervalBell(config, state),
  rep_counter: repCounterSummary,
  sense_grounding: (config, state) => summarizeSenseGrounding(config, state),
  tallied_grounding: harvestTalliedGrounding,
  tarot: (_config, state, tarotCardIndex) => summarizeTarot(state, tarotCardIndex),
  card_meditation: (config, state, _tarotCardIndex, cardPick) =>
    summarizeCardMeditation(config, state, cardPick),
  mindful_anchor: () => ({ mode: 'mindful_anchor' }),
};

function harvestEngineSummary(
  config: EngineMetadataConfig,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
): ModeSummaryMetadata {
  type AnyHarvester = (
    config: EngineMetadataConfig,
    state: RitualState,
    tarotCardIndex: number,
    cardPick: PickedCard | null,
  ) => ModeSummaryMetadata;
  return (ENGINE_SUMMARY_HARVESTERS[config.mode] as AnyHarvester)(
    config,
    state,
    tarotCardIndex,
    cardPick,
  );
}

function repCounterSummary(config: RepCounterConfig, state: RitualState): ModeSummaryMetadata {
  return {
    mode: 'rep_counter',
    rep_count: state.repCount,
    unit_label: config.unit_label,
  };
}
