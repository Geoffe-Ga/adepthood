/**
 * What a writer loses without a key of their own (ADR 0009 phase (a), #3067).
 *
 * Owner-approved wording (#3262). It replaces copy that promised a fallback to
 * the operator's own credential, which phase (a) removed: it no longer pays
 * for any request carrying a person's writing. It states the feature loss plainly
 * and makes no new privacy promise -- public privacy claims wait for B24
 * (#3076).
 */

/** Under the key field while no key is saved. */
export const NO_KEY_HINT =
  "No key saved yet. BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — need a key of your own, and credits don't pay for them. Resonance notes and letters can still come from your vault if you have one.";

/** The remove-key confirmation's body. */
export const REMOVE_KEY_DIALOG_BODY =
  "Without your own key, BotMason's cloud AI features — resonance notes, letters, completion checks and page reading — stop until you add one again. Resonance notes and letters can still come from your vault if you have one. Your journal itself is unaffected.";

/**
 * A managed vault's sort stopped because the writer's AI provider refused their
 * key (Creek contract 0.26, #3595). Calm and specific: it names who refused,
 * what stopped and the one remedy, and never repeats the key or the vendor's
 * words. It promises no retry adepthood will not make -- a refused key is not
 * re-sent -- only that a replaced key is used on the next write.
 */
export const KEY_REJECTED_NOTICE =
  'Your AI provider turned down the API key your vault last used to sort your writing, so that sort stopped. Your writing is all still here. Paste a working key below and your vault will use it the next time you write.';

/** The hub's API key row while that refusal stands: where to go, not what went wrong. */
export const KEY_REJECTED_HUB_DESCRIPTION =
  'Your AI provider turned down your API key. Replace it here.';
