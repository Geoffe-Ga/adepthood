/**
 * The words of the resonance spend disclosure.
 *
 * The server-owned route determines who pays. Supported app_provider readings
 * require the caller's own API key. Successful vault_bound readings spend
 * BotMason credits even when that key is present; a bound route alone does not
 * mean the vault can answer.
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
 * The copy states the most a pass can send to the app's AI model provider,
 * which is what a writer with no connected vault always gets. (Since #3061 a
 * writer whose vault is connected is never re-routed there: a vault that cannot
 * answer, and completion detection, fail closed rather than fall back. This
 * comment records that; the copy below deliberately makes no claim about it --
 * any wording about where a vault-bound pass is processed is the owner's.)
 * That maximum is:
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

/** What a resonance pass is called in its price line. */
const READING = 'reading';

/**
 * The price, derived from who pays and the allowance this deployment serves.
 *
 * ``noun`` names the charged thing — a ``reading`` (the pass, and the default,
 * so the pass's copy is unchanged) or a ``letter`` (a note's first essay, via
 * {@link essayExplainerCost}). A vault-bound first letter uses the same wallet
 * price as a reading; its server negotiates support and refunds any unkept letter.
 */
export function resonanceExplainerCost(
  hasKey: boolean,
  monthlyCap: number | null,
  monthlyRemaining: number | null = null,
  offeringBalance: number | null = null,
  noun: string = READING,
  vaultBound: boolean = false,
): string {
  if (hasKey && !vaultBound) {
    return `Your own API key pays for this ${noun}. Nothing is drawn from your BotMason messages.`;
  }
  if (!vaultBound) return keyNeededCost(noun);
  return vaultPrice(monthlyCap, monthlyRemaining, offeringBalance, noun);
}

function vaultPrice(
  monthlyCap: number | null,
  monthlyRemaining: number | null,
  offeringBalance: number | null,
  noun: string,
): string {
  if (monthlyRemaining === 0 && offeringBalance === 0) {
    return `You have no BotMason monthly messages or offerings available for this ${noun}.`;
  }
  if (monthlyCap === 0 || monthlyRemaining === 0) {
    return `This ${noun} spends one BotMason offering.`;
  }
  if (monthlyCap !== null) {
    return `This ${noun} spends one of your ${monthlyCap} BotMason messages for the month.`;
  }
  return `This ${noun} spends one BotMason message from your account.`;
}

/** What a note's first letter is called in its price line. */
export const ESSAY_NOUN = 'letter';

/**
 * A supported first app_provider letter uses the caller's own API key. First
 * vault_bound letters spend one wallet unit; opening an already written letter is free.
 */
export function essayExplainerCost(
  hasKey: boolean,
  monthlyCap: number | null,
  monthlyRemaining: number | null = null,
  offeringBalance: number | null = null,
): string {
  return resonanceExplainerCost(hasKey, monthlyCap, monthlyRemaining, offeringBalance, ESSAY_NOUN);
}

export const KEY_NEEDED_LEAD = 'This needs your own API key.';

/** The keyless line for a thing only the writer's own key can pay for. */
export function keyNeededCost(noun: string = READING): string {
  return `${KEY_NEEDED_LEAD} Add one in Settings to ask for this ${noun}.`;
}

/** The action that replaces the charged arm while only a key can pay. */
export const KEY_NEEDED_SETTINGS = 'Open Settings';
export const KEY_NEEDED_SETTINGS_A11Y = 'Open Settings to add your own API key';

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

/**
 * Shown above a price disclosed again because the server refused a request
 * whose payer had changed since the writer last saw it (#3385): a vault
 * connected or disconnected on another device, or a wallet refilled. Says that
 * nothing was spent, so asking again is a fresh, informed choice.
 */
export const PAYER_CHANGED_NOTICE =
  'Nothing was charged. How this would be paid for changed since you looked, so here it is again.';

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

/**
 * Why a saved key does not help an empty wallet pay for a first letter: the
 * vault writes it and never uses the key (#3281/#3346). The letter's half of the
 * refill dialog's "Readings your vault answers use BotMason credits".
 */
export const ESSAY_VAULT_USES_CREDITS =
  'Letters your vault writes use BotMason credits, even when an API key is saved.';
