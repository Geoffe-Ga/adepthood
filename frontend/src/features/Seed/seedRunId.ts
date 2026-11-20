/**
 * The id one seeding run sends with each of its documents (#3770).
 *
 * The server lets a run's documents share one vault capability handshake,
 * keyed on the account, the vault and this id, so a forty-file folder probes
 * the vault once rather than forty times. The id decides nothing about any
 * document: it is opaque, never shown, never stored, and new for every run.
 *
 * Drawn from the platform CSPRNG, as the app's other random material is, and
 * spelled in hex so it always fits the server's `upload_run_id` pattern.
 */

/** Bytes of randomness in one id: 128 bits, 32 hex characters. */
const SEED_RUN_ID_BYTES = 16;

const HEX_RADIX = 16;
const HEX_PAIR = 2;

/** A fresh, unguessable id for one run. */
export function mintSeedRunId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(SEED_RUN_ID_BYTES));
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_PAIR, '0')).join('');
}
