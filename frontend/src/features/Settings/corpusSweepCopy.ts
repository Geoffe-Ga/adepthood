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
 */

import {
  CORPUS_INVITATION_NEVER_LABEL,
  CORPUS_INVITATION_NOT_NOW_LABEL,
} from './corpusConsentCopy';

import type { CorpusSweepResult } from '@/api';

/**
 * The most entries one pass sorts: the backend's ``BACKFILL_ENTRY_CEILING``.
 *
 * Quoted on the button, so ``corpusSweepCopy.test.ts`` reads the Python
 * constant back and fails if the two ever disagree.
 */
export const CORPUS_SWEEP_PASS_ENTRY_LIMIT = 40;

/** The hub row's label, and the screen's title. */
export const CORPUS_SWEEP_ROW_LABEL = 'Sort the rest of your writing';
export const CORPUS_SWEEP_TITLE = CORPUS_SWEEP_ROW_LABEL;

/** Heading over the shared lines about what sorting does. */
export const CORPUS_SWEEP_WHAT_HEADING = 'What sorting does';

/** Why it takes passes, and that each one waits for the person to ask. */
export const CORPUS_SWEEP_BOUND_LINE =
  `Each pass sorts up to ${CORPUS_SWEEP_PASS_ENTRY_LIMIT} entries, so a long backlog takes a ` +
  'few passes. A pass starts only when you ask for one.';

/** Said when the backlog is empty, on arrival or after a pass. */
export const CORPUS_SWEEP_NOTHING_PENDING = 'Nothing is waiting to be sorted.';

/**
 * Why a pass can sort nothing, said beside a remainder that did not move.
 *
 * Each cause is one the backend has: no standing consent sweeps nothing, a
 * vault-bound writer's sweep stops before its first offer (#3156), and an entry
 * the classifier places nowhere stays pending on purpose.
 */
export const CORPUS_SWEEP_NOTHING_SORTED_REASON =
  'A pass sorts nothing when sorting is off for what you write here, when a vault of your own ' +
  'answers for your writing, or when the entries left are ones that could not be placed yet.';

/** The per-account limit on passes (``429``): a wait, not a fault. */
export const CORPUS_SWEEP_RATE_LIMITED =
  'You have asked for several passes in a short while. Give it a minute, then ask again.';

/** A pass whose answer never came back: say only what is known. */
export const CORPUS_SWEEP_FAILURE =
  'That pass did not come back, so this screen cannot say what it sorted. You can ask again.';

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

/** The note navigates; the pass, and its confirm, live on the next screen. */
export const CORPUS_SWEEP_OFFER_NEXT_STEP =
  'Nothing is sorted from here. The next screen says how a pass works and waits for you to ask.';

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

/** The confirm: the next pass, never more than one pass sorts. */
export function corpusSweepActionLabel(pending: number): string {
  return `Sort the next ${Math.min(pending, CORPUS_SWEEP_PASS_ENTRY_LIMIT)}`;
}

/**
 * What one pass did, and what it left.
 *
 * A pass that sorted nothing leads with that, so a remainder that did not move
 * can never read as success.
 */
export function corpusSweepOutcomeLine(result: CorpusSweepResult): string {
  const left =
    result.entries_remaining === 0
      ? 'Nothing is left unsorted.'
      : `${entries(result.entries_remaining)} still unsorted.`;
  if (result.entries_sorted === 0) {
    return result.entries_remaining === 0
      ? CORPUS_SWEEP_NOTHING_PENDING
      : `Nothing was sorted this pass. ${left}`;
  }
  return `Sorted ${entries(result.entries_sorted)} this pass. ${left}`;
}

/** Every fixed line, so a copy sweep can read them all. */
export const CORPUS_SWEEP_COPY_ENTRIES: readonly string[] = [
  CORPUS_SWEEP_ROW_LABEL,
  CORPUS_SWEEP_WHAT_HEADING,
  CORPUS_SWEEP_BOUND_LINE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_FAILURE,
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
