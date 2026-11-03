/**
 * Everything the "Sort the rest of your writing" row and screen say (#3499).
 *
 * A sibling of ``corpusConsentCopy.ts`` under the same two rules, held by
 * ``corpusSweepCopy.test.ts``: it says what the code does and nothing more, and
 * it does not sell. What sorting *does* is not restated here -- the screen
 * reuses ``CORPUS_CONSENT_GAIN`` and ``CORPUS_INVITATION_REACH`` so there is one
 * vocabulary for it, not two.
 *
 * There is no price on this surface, so there is no money language either.
 * Sorting is free (#3495): the shipped ``POST /corpus/sweep`` takes no body and
 * quotes no price, and the provider bill is bounded by a per-account ceiling
 * (#3514), not by anything a person is asked to acknowledge here.
 *
 * One press sorts everything (``services/corpus_sort_run.py``): the screen
 * starts a background run and follows it, so the copy speaks of a sort that is
 * going and then of how it ended -- never of passes or a per-press bound.
 */

import {
  CORPUS_INVITATION_NEVER_LABEL,
  CORPUS_INVITATION_NOT_NOW_LABEL,
} from './corpusConsentCopy';

import type { CorpusSortRun } from '@/api';

/** The hub row's label, and the screen's title. */
export const CORPUS_SWEEP_ROW_LABEL = 'Sort the rest of your writing';
export const CORPUS_SWEEP_TITLE = CORPUS_SWEEP_ROW_LABEL;

/** Heading over the shared lines about what sorting does. */
export const CORPUS_SWEEP_WHAT_HEADING = 'What sorting does';

/** How a sort runs: once, for everything, in the background, and only on a press. */
export const CORPUS_SWEEP_HOW_LINE =
  'One press sorts everything that is waiting. It runs in the background, so you can leave ' +
  'this screen, and pressing again while it runs starts nothing new.';

/** Said when the backlog is empty, on arrival or after a sort. */
export const CORPUS_SWEEP_NOTHING_PENDING = 'Nothing is waiting to be sorted.';

/**
 * Why a sort that ran to the end can leave writing behind, said beside it.
 *
 * Every other cause ends a sort with a reason of its own
 * (:data:`CORPUS_SORT_STOP_LINES`); what is left after a sort that finished is
 * writing the classifier could place nowhere, which stays waiting on purpose.
 */
export const CORPUS_SWEEP_NOTHING_SORTED_REASON =
  'Entries that could not be placed yet stay waiting, and a later sort tries them again.';

/** The per-account limit on presses (``429``): a wait, not a fault. */
export const CORPUS_SWEEP_RATE_LIMITED =
  'You have pressed Sort several times in a short while. Give it a minute, then press again.';

/** A press whose answer never came back: say only what is known. */
export const CORPUS_SWEEP_FAILURE =
  'That press did not come back, so this screen cannot say whether sorting started. You can ' +
  'press again; it will not start twice.';

/** A sort that ended on a fault of ours: what it sorted is kept. */
export const CORPUS_SORT_FAILED =
  'Sorting stopped partway because of a problem on our side. What it sorted is kept, and you ' +
  'can start it again.';

/** Why a sort ended before offering everything, one line per backend reason. */
export const CORPUS_SORT_STOP_LINES: Readonly<
  Record<NonNullable<CorpusSortRun['stop_reason']>, string>
> = {
  no_consent: 'Nothing was sorted, because sorting is off for what you write here.',
  consent_withdrawn: 'Sorting stopped because sorting was turned off for what you write here.',
  boundary_changed:
    'Sorting stopped because your vault connection changed. Starting again sorts into the ' +
    'right place.',
  suspended: 'Sorting is paused on our side for now. You can try again later.',
  provider_refused:
    'Sorting stopped because the service that sorts writing is not answering right now. You ' +
    'can try again later.',
  vault_unavailable:
    'Sorting stopped because your vault could not be reached. You can start again once it ' +
    'is back.',
};

/** The count itself did not load. */
export const CORPUS_SWEEP_READ_FAILURE =
  'How much is unsorted did not load. Check your connection and try again.';

export const CORPUS_SWEEP_RETRY_LABEL = 'Try again';

/**
 * The journal page's offer (#3500): a note beside the page that points at this
 * screen. It reuses ``CORPUS_CONSENT_GAIN`` for what sorting does and
 * ``corpusSweepPendingLine`` for how much is waiting, so the only lines it adds
 * are its eyebrow, that nothing is sorted from the note itself, and its
 * controls. The two declines carry the consent invitation's own labels.
 */
export const CORPUS_SWEEP_OFFER_LABEL = 'Your earlier writing';

/** The note navigates; the sort, and its confirm, live on the next screen. */
export const CORPUS_SWEEP_OFFER_NEXT_STEP =
  'Nothing is sorted from here. The next screen says how sorting works and waits for you to ask.';

export const CORPUS_SWEEP_OFFER_OPEN_LABEL = CORPUS_SWEEP_ROW_LABEL;
export const CORPUS_SWEEP_OFFER_OPEN_A11Y = 'Open the screen for sorting the rest of your writing';

/** A plain decline: not asked again this session. */
export const CORPUS_SWEEP_OFFER_NOT_NOW_LABEL = CORPUS_INVITATION_NOT_NOW_LABEL;
export const CORPUS_SWEEP_OFFER_NOT_NOW_A11Y =
  'Set the offer to sort your earlier writing aside for now';

/** A final decline: not offered on the journal page again. Settings still has the row. */
export const CORPUS_SWEEP_OFFER_NEVER_LABEL = CORPUS_INVITATION_NEVER_LABEL;
export const CORPUS_SWEEP_OFFER_NEVER_A11Y = 'Do not offer to sort your earlier writing again';

/** ``1 entry`` / ``412 entries``. */
function entries(count: number): string {
  return count === 1 ? '1 entry' : `${count} entries`;
}

/** The hub row's description: how much is still unsorted. */
export function corpusSweepRowDescription(pending: number): string {
  return `${entries(pending)} still unsorted`;
}

/** The screen's lead: how much is still unsorted, in a sentence. */
export function corpusSweepPendingLine(pending: number): string {
  return pending === 1
    ? "1 of your entries hasn't been sorted yet."
    : `${pending} of your entries haven't been sorted yet.`;
}

/** The confirm: one press for everything waiting. */
export function corpusSweepActionLabel(pending: number): string {
  return pending === 1 ? 'Sort 1 entry' : `Sort all ${pending} entries`;
}

/**
 * How far a running sort has got.
 *
 * Never a bare zero (the screen-wide rule the price test holds): before the
 * first entry is looked at it names what it is sorting instead.
 */
export function corpusSortProgressLine(run: CorpusSortRun): string {
  const total = Math.max(run.entries_total, run.entries_offered);
  if (run.entries_offered > 0) {
    return `Sorting in the background: ${run.entries_offered} of ${total} looked at so far.`;
  }
  return total > 0 ? `Sorting ${entries(total)} in the background.` : 'Sorting in the background.';
}

/** What is still waiting, as the tail of an outcome line. */
function leftLine(pending: number): string {
  return pending === 0 ? 'Nothing is left unsorted.' : `${entries(pending)} still unsorted.`;
}

/** What a sort sorted before it stopped, if anything, as a middle clause. */
function sortedFirst(run: CorpusSortRun): string {
  return run.entries_sorted > 0 ? ` It sorted ${entries(run.entries_sorted)} first.` : '';
}

/** How a sort that ran to the end turned out. */
function completedLine(run: CorpusSortRun, pending: number): string {
  if (run.entries_sorted > 0) return `Sorted ${entries(run.entries_sorted)}. ${leftLine(pending)}`;
  return pending === 0 ? CORPUS_SWEEP_NOTHING_PENDING : `Nothing was sorted. ${leftLine(pending)}`;
}

/**
 * How a finished sort ended, and what it left.
 *
 * A sort that sorted nothing leads with that, so a remainder that did not move
 * can never read as success; a stopped one leads with why.
 */
export function corpusSortOutcomeLine(run: CorpusSortRun, pending: number): string {
  if (run.state === 'failed') return `${CORPUS_SORT_FAILED} ${leftLine(pending)}`;
  if (run.stop_reason !== null) {
    return `${CORPUS_SORT_STOP_LINES[run.stop_reason]}${sortedFirst(run)} ${leftLine(pending)}`;
  }
  return completedLine(run, pending);
}

/** Every fixed line, so a copy sweep can read them all. */
export const CORPUS_SWEEP_COPY_ENTRIES: readonly string[] = [
  CORPUS_SWEEP_ROW_LABEL,
  CORPUS_SWEEP_WHAT_HEADING,
  CORPUS_SWEEP_HOW_LINE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_FAILURE,
  CORPUS_SORT_FAILED,
  ...Object.values(CORPUS_SORT_STOP_LINES),
  CORPUS_SWEEP_READ_FAILURE,
  CORPUS_SWEEP_RETRY_LABEL,
  CORPUS_SWEEP_OFFER_LABEL,
  CORPUS_SWEEP_OFFER_NEXT_STEP,
  CORPUS_SWEEP_OFFER_OPEN_A11Y,
  CORPUS_SWEEP_OFFER_NOT_NOW_LABEL,
  CORPUS_SWEEP_OFFER_NOT_NOW_A11Y,
  CORPUS_SWEEP_OFFER_NEVER_LABEL,
  CORPUS_SWEEP_OFFER_NEVER_A11Y,
];
