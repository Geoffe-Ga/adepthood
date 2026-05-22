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
  | ModeSummaryRepCounter
  | ModeSummarySenseGrounding
  | ModeSummaryTalliedGrounding
  | ModeSummaryTarot
  | ModeSummaryCardMeditation;

export type ModeSummaryKind = ModeSummaryMetadata['mode'];

function clock(durationMinutes: number): string {
  return formatTime(Math.max(0, durationMinutes) * MS_PER_MINUTE);
}

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
  const mmss = clock(durationMinutes);
  switch (mode) {
    case 'meditation_timer':
      return `${mmss} of stillness`;
    case 'count_up':
      return `${mmss} of open practice`;
    case 'metronome': {
      const m = metadata as ModeSummaryMetronome;
      return `BPM ${m.bpm_used} for ${mmss}`;
    }
    case 'interval_bell': {
      const m = metadata as ModeSummaryIntervalBell;
      return `${m.intervals_struck}/${m.total_intervals} bells over ${mmss}`;
    }
    case 'rep_counter': {
      const m = metadata as ModeSummaryRepCounter;
      return `${m.rep_count} ${m.unit_label} in ${mmss}`;
    }
    case 'sense_grounding': {
      const m = metadata as ModeSummarySenseGrounding;
      return `Grounded through ${m.senses_completed.length} senses`;
    }
    case 'tallied_grounding': {
      const m = metadata as ModeSummaryTalliedGrounding;
      return `${m.items_completed} items across ${m.rounds_completed}/${m.total_rounds} rounds`;
    }
    case 'tarot': {
      const m = metadata as ModeSummaryTarot;
      return `${m.card_name} for ${mmss}`;
    }
    case 'card_meditation': {
      const m = metadata as ModeSummaryCardMeditation;
      return `${m.card_name} for ${mmss}`;
    }
    default:
      return assertNever(mode);
  }
}

function assertNever(mode: never): never {
  throw new Error(`formatModeSummary: unhandled mode ${String(mode)}`);
}
