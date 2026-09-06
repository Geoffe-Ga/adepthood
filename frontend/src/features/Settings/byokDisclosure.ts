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
  'Stored on your device; sent over HTTPS through Adepthood to your model provider when used.';

/** Full disclosure shown before somebody saves a provider credential. */
export const BYOK_DETAIL_DISCLOSURE =
  'Your key is stored on this device. When an AI feature uses it, the production app sends it ' +
  "over HTTPS to Adepthood's server in the X-LLM-API-Key header. Adepthood forwards it over " +
  'HTTPS to your selected model provider for that request and does not persist it.';
