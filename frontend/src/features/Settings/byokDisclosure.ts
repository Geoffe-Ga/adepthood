/**
 * The two user-facing summaries of where a bring-your-own model key travels.
 *
 * The key rests in device storage between requests. Page reading then sends it
 * from the device straight to the chosen vendor (ADR 0009 phase (a), #3067);
 * every other AI feature sends it over HTTPS through Adepthood to that vendor.
 * The hub wording is the owner's, decided on 2026-10-14 (#3260). Keep these
 * exports as the only Settings wording so the contract test can hold both
 * surfaces to the transport and forwarding implementation.
 */

/** Compact disclosure for the Settings hub row: the owner's wording (#3260). */
export const BYOK_HUB_DISCLOSURE =
  "Kept on your device. Page reading sends it from this device straight to the AI provider you chose, which sees your device's IP address. " +
  'Other features send it over HTTPS through Adepthood to that provider, only when a feature uses it.';

/**
 * What a managed vault does with the key (#3437, ADR 0009's 2026-10-16
 * amendment): readings, letters and the sorting of new writing go from
 * Adepthood to the writer's vault, which sends that writing to their provider
 * with the key. Intimate entries never reach the vault, so never the provider.
 */
export const BYOK_MANAGED_VAULT_DISCLOSURE =
  'With a managed vault, those features pass it on from Adepthood to your vault, which sends your writing to that provider with it and keeps none of it. Entries you mark Intimate never go.';

/** Full disclosure shown before somebody saves a provider credential. */
export const BYOK_DETAIL_DISCLOSURE =
  `${BYOK_HUB_DISCLOSURE} ${BYOK_MANAGED_VAULT_DISCLOSURE} ` +
  'Adepthood does not persist it: nothing of your key is kept once the reply is back.';
