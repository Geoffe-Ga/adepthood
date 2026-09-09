/**
 * The words of the resonance spend disclosure.
 *
 * A resonance pass costs money. The backend deducts one message from the
 * account's monthly BotMason allowance before it dials the model, and until this
 * disclosure existed the first anyone heard of that was the 402 that arrives
 * once the allowance is gone — the price was quoted after it had been paid.
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

/** What a pass does, and the fact that the entry leaves the device to do it. */
export const RESONANCE_EXPLAINER_WHAT =
  'Resonance reads this entry and leaves margin notes beside the passages it responds to. To do that, the text of this entry is sent to an AI model.';

/** The price, said plainly and without softening. */
export const RESONANCE_EXPLAINER_COST =
  'Each reading spends one of your free BotMason messages for the month. If you have added your own API key in Settings, it bills that key instead.';

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
