/**
 * What a writer loses without a key of their own (ADR 0009 phase (a), #3067).
 *
 * DRAFT for owner review: the wording is an agent's draft, listed for the owner
 * in the lane report. It replaces copy that promised a fallback to the
 * operator's own credential, which phase (a) removed: it no longer pays for
 * any request carrying a person's writing. It states the feature loss plainly
 * and makes no new privacy promise -- public privacy claims wait for B24
 * (#3076).
 */

/** Under the key field while no key is saved. */
export const NO_KEY_HINT =
  "No key saved yet. BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — need a key of your own, and credits don't pay for them. Resonance notes can still come from your vault if you have one.";

/** The remove-key confirmation's body. */
export const REMOVE_KEY_DIALOG_BODY =
  "Without your own key, BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — stop until you add one again. Resonance notes can still come from your vault if you have one. Your journal itself is unaffected.";
