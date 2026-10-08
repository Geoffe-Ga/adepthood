/**
 * The two user-facing summaries of where a bring-your-own model key travels.
 *
 * The key has two distinct lives and the copy must name both: it rests in
 * device storage between requests, then crosses Adepthood on its way to the
 * selected model provider when an AI feature uses it. Keep these exports as
 * the only Settings wording so the contract test can hold both surfaces to
 * the transport and forwarding implementation.
 */

/** Compact disclosure for the Settings hub row. */
export const BYOK_HUB_DISCLOSURE =
  'Kept on your device; sent over an encrypted connection (HTTPS) through Adepthood to the AI provider you chose, only when a feature uses it.';

/** Full disclosure shown before somebody saves a provider credential. */
export const BYOK_DETAIL_DISCLOSURE =
  'Your key is kept on this device. When an AI feature uses it, the app sends it over an ' +
  'encrypted connection (HTTPS) to Adepthood, which passes it straight on to the AI provider you ' +
  'chose for that one request. Adepthood does not persist it: nothing of your key is kept once ' +
  'the reply is back.';
