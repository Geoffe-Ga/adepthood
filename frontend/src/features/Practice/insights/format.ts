/**
 * Pure post-session summary formatter for the insight-capture modal.
 *
 * Each per-mode shape mirrors the backend's
 * :class:`schemas.practice_session_metadata.SessionMetadata` discriminated
 * union, with two presentation-only extras the backend doesn't store:
 *
 *   - ``rep_counter.unit_label`` — the user-facing noun (e.g. "breath cycles");
 *     the backend only persists ``rep_count``.
 *   - ``tarot.card_name`` — resolved by the parent from the card index via
 *     :func:`features/Practice/data/tarot::cardForDayIndex`; the backend
 *     persists ``card_index`` and re-resolves the name as needed.
 *
 * The caller strips these fields before POSTing to ``/practice-sessions``.
 */

import type { SenseKind } from '../engine/types';
import { formatTime } from '../views/formatTime';

const MS_PER_MINUTE = 60_000;

export interface ModeSummaryMeditationTimer {
  readonly mode: 'meditation_timer';
}

export interface ModeSummaryCountUp {
  readonly mode: 'count_up';
}

export interface ModeSummaryMetronome {
  readonly mode: 'metronome';
  readonly bpm_used: number;
}

export interface ModeSummaryIntervalBell {
  readonly mode: 'interval_bell';
  readonly intervals_struck: number;
  readonly total_intervals: number;
}

export interface ModeSummaryRandomIntervalBell {
  readonly mode: 'random_interval_bell';
  readonly bells_struck: number;
}

export interface ModeSummaryRepCounter {
  readonly mode: 'rep_counter';
  readonly rep_count: number;
  readonly unit_label: string;
}

export interface ModeSummarySenseGrounding {
  readonly mode: 'sense_grounding';
  readonly senses_completed: readonly SenseKind[];
}

export interface ModeSummaryTarot {
  readonly mode: 'tarot';
  readonly card_index: number;
  readonly card_name: string;
}

export interface ModeSummaryCardMeditation {
  readonly mode: 'card_meditation';
  readonly deck_id: string;
  readonly card_name: string;
}

export interface ModeSummaryTalliedGrounding {
  readonly mode: 'tallied_grounding';
  readonly rounds_completed: number;
  readonly total_rounds: number;
  readonly items_completed: number;
}

export type ModeSummaryMetadata =
  | ModeSummaryMeditationTimer
  | ModeSummaryCountUp
  | ModeSummaryMetronome
  | ModeSummaryIntervalBell
  | ModeSummaryRandomIntervalBell
  | ModeSummaryRepCounter
  | ModeSummarySenseGrounding
  | ModeSummaryTalliedGrounding
  | ModeSummaryTarot
  | ModeSummaryCardMeditation;

export type ModeSummaryKind = ModeSummaryMetadata['mode'];

function clock(durationMinutes: number): string {
  return formatTime(Math.max(0, durationMinutes) * MS_PER_MINUTE);
}

/** Shared formatter for the two card-based modes (`tarot`, `card_meditation`). */
const cardSummary = (metadata: { card_name: string }, mmss: string): string =>
  `${metadata.card_name} for ${mmss}`;

/** Per-mode summary formatters; the mapped type enforces exhaustive coverage. */
const SUMMARY_FORMATTERS: {
  [K in ModeSummaryKind]: (
    metadata: Extract<ModeSummaryMetadata, { mode: K }>,
    mmss: string,
  ) => string;
} = {
  meditation_timer: (_metadata, mmss) => `${mmss} of stillness`,
  count_up: (_metadata, mmss) => `${mmss} of open practice`,
  metronome: (metadata, mmss) => `BPM ${metadata.bpm_used} for ${mmss}`,
  interval_bell: (metadata, mmss) =>
    `${metadata.intervals_struck}/${metadata.total_intervals} bells over ${mmss}`,
  random_interval_bell: (metadata, mmss) => `${metadata.bells_struck} random bells over ${mmss}`,
  rep_counter: (metadata, mmss) => `${metadata.rep_count} ${metadata.unit_label} in ${mmss}`,
  sense_grounding: (metadata, _mmss) =>
    `Grounded through ${metadata.senses_completed.length} senses`,
  tallied_grounding: (metadata, _mmss) =>
    `${metadata.items_completed} items across ` +
    `${metadata.rounds_completed}/${metadata.total_rounds} rounds`,
  tarot: cardSummary,
  card_meditation: cardSummary,
};

/**
 * Render the one-line post-session summary shown above the insight input.
 *
 * The ``mode`` parameter is duplicated with ``metadata.mode`` so the
 * call-site discriminator matches the payload at compile time; the
 * generic constraint narrows ``metadata`` to the shape that matches the
 * literal ``mode``. Passing a mismatched pair fails type-check rather
 * than producing a silently wrong summary.
 */
export function formatModeSummary<M extends ModeSummaryKind>(
  mode: M,
  durationMinutes: number,
  metadata: Extract<ModeSummaryMetadata, { mode: M }>,
): string {
  // Mapped type proves the lookup is total; the runtime guard catches `as unknown` callers.
  type AnyFormatter = (metadata: ModeSummaryMetadata, mmss: string) => string;
  const formatter = SUMMARY_FORMATTERS[mode] as AnyFormatter | undefined;
  if (formatter === undefined) return assertNever(mode as never);
  return formatter(metadata, clock(durationMinutes));
}

function assertNever(mode: never): never {
  throw new Error(`formatModeSummary: unhandled mode ${String(mode)}`);
}
