/**
 * The words of the resonance spend disclosure.
 *
 * A resonance pass costs money. The caller's own API key pays when present;
 * otherwise the backend deducts one message from the account's BotMason wallet
 * before it dials the model. Until this disclosure existed the first anyone
 * heard of that was the 402 that arrives once the allowance is gone.
 *
 * So the copy has one job, in this order: what the pass does, where the entry
 * goes, what it costs, and that declining is free. It is deliberately flat about
 * the price — no "just one message", no reassurance the reader did not ask for —
 * and equally flat about running it. Nothing here argues for either arm; the two
 * actions are the same size, sit next to each other, and the back-out is not
 * hidden behind a scrim tap. "You choose your depth" (NORTH-STAR) means a
 * charged depth is offered with its price on it, and declining costs nothing.
 *
 * The BotMason / "your own API key in Settings" vocabulary matches
 * ``api/errorMessages.ts``'s ``insufficient_offerings`` on purpose: someone who
 * eventually meets that error should recognise the thing they were told about.
 */

/** The heading. Names the subject, not the decision — the reader decides. */
export const RESONANCE_EXPLAINER_TITLE = 'Before the reading';

/**
 * What a pass does, and everything that leaves the device to do it (#2998).
 *
 * The copy states the most a pass can send, because a connected vault that
 * degrades hands the full prompt to the cloud and completion detection always
 * goes to the cloud. That maximum is:
 *
 * - the entry itself (`build_prompt`'s `<entry>`);
 * - up to three other pieces of the writer's own writing (`<prior>`), chosen
 *   by `gather_grounding` (`GROUNDING_LIMIT`): corpus fragments, which may be
 *   documents the writer uploaded or imported, or else their recent entries --
 *   so "other entries" would undersell it;
 * - short excerpts of earlier letters (`<prior_letters>`, `_prior_letter_essays`);
 * - the names and units of the writer's habits and practices, which
 *   `detect_completions` / `build_detection_prompt` send to notice completions.
 *
 * The count agrees with the privacy policy's "up to three", and
 * `backend/tests/test_legal_documents.py` holds it to `GROUNDING_LIMIT`.
 */
export const RESONANCE_EXPLAINER_WHAT =
  'Resonance reads this entry and leaves margin notes beside the passages it responds to. To do that, the text of this entry, up to three other pieces of your own writing, short excerpts of your earlier letters, and the names and units of your habits and practices are sent to an AI model.';

const ADD_KEY = 'Add your own API key in Settings to bill that key instead.';

/** What a resonance pass is called in its price line. */
const READING = 'reading';

/**
 * The price, derived from who pays and the allowance this deployment serves.
 *
 * ``noun`` names the charged thing — a ``reading`` (the pass, and the default,
 * so the pass's copy is unchanged) or a ``letter`` (a note's first essay, via
 * {@link essayExplainerCost}). One function, so the two prices can never be
 * worded differently for the same wallet.
 */
export function resonanceExplainerCost(
  hasKey: boolean,
  monthlyCap: number | null,
  monthlyRemaining: number | null = null,
  offeringBalance: number | null = null,
  noun: string = READING,
): string {
  if (hasKey) {
    return `Your own API key pays for this ${noun}. Nothing is drawn from your BotMason messages.`;
  }
  if (monthlyRemaining === 0 && offeringBalance === 0) {
    return `You have no BotMason monthly messages or offerings available for this ${noun}. ${ADD_KEY}`;
  }
  if (monthlyCap === 0 || monthlyRemaining === 0) {
    return `This ${noun} spends one BotMason offering. ${ADD_KEY}`;
  }
  if (monthlyCap !== null) {
    return `This ${noun} spends one of your ${monthlyCap} BotMason messages for the month. ${ADD_KEY}`;
  }
  return `This ${noun} spends one BotMason message from your account. ${ADD_KEY}`;
}

/** What a note's first letter is called in its price line. */
export const ESSAY_NOUN = 'letter';

/** The price of a note's first letter: the same wallet and wording as a reading. */
export function essayExplainerCost(
  hasKey: boolean,
  monthlyCap: number | null,
  monthlyRemaining: number | null = null,
  offeringBalance: number | null = null,
): string {
  return resonanceExplainerCost(hasKey, monthlyCap, monthlyRemaining, offeringBalance, ESSAY_NOUN);
}

/** Whether the known payer snapshot can fund a pass; unknown reads stay retryable. */
export function resonanceExplainerCanContinue(
  hasKey: boolean,
  monthlyRemaining: number | null,
  offeringBalance: number | null,
): boolean {
  return hasKey || monthlyRemaining === null || offeringBalance === null
    ? true
    : monthlyRemaining > 0 || offeringBalance > 0;
}

/** That either answer is fine, and that nothing is lost by waiting. */
export const RESONANCE_EXPLAINER_CHOICE =
  'The entry is already saved. You can ask for a reading now, or later, or never.';

export const RESONANCE_EXPLAINER_CONTINUE = 'Continue';
export const RESONANCE_EXPLAINER_CONTINUE_A11Y = 'Continue and read this entry';

export const RESONANCE_EXPLAINER_CANCEL = 'Not now';
export const RESONANCE_EXPLAINER_CANCEL_A11Y = 'Not now — do not read this entry';

export const RESONANCE_EXPLAINER_DONT_SHOW = 'Don’t show this again';
export const RESONANCE_EXPLAINER_DONT_SHOW_A11Y =
  'Don’t show this note again before a resonance reading';

export const RESONANCE_EXPLAINER_SCRIM_A11Y = 'Dismiss the resonance note';

/*
 * The essay offer (#623). A note's first letter is a charged depth too, so it
 * is offered with its price on it rather than written the moment the note is
 * opened. Same shape and same flatness as the reading: what it does, where the
 * entry goes, what it costs, and that declining — or waiting — is free. The
 * last line is the one thing a letter has that a reading does not: once
 * written, it is kept, and opening it again costs nothing.
 */

/**
 * What asking does, and everything that leaves the device to do it: the
 * entry, the note, and the short excerpts of earlier letters the backend sends
 * as anti-repetition context (`_prior_letter_essays`).
 */
export const ESSAY_ASK_WHAT =
  'A letter expands this margin note into a longer reflection. To write it, the text of this entry, this margin note, and short excerpts of your earlier letters are sent to an AI model.';

/** That either answer is fine, and that a written letter is never charged again. */
export const ESSAY_ASK_CHOICE =
  'Once written, the letter stays with this note, and opening it again costs nothing. You can ask now, or later, or never.';

export const ESSAY_ASK_PROCEED = 'Ask for the letter';
export const ESSAY_ASK_PROCEED_A11Y = 'Ask for the letter for this note';

export const ESSAY_ASK_CANCEL = 'Not now';
export const ESSAY_ASK_CANCEL_A11Y = 'Not now — do not write this letter';
