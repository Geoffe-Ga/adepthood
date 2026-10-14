/**
 * Passphrase and recovery-phrase key derivation: Argon2id (RFC 9106).
 *
 * Production parameters, chosen for the web client: 64 MiB of memory, 3
 * passes, 1 lane. This is RFC 9106's second recommended option (section 4)
 * with the lane count cut to 1, because the pure-JavaScript implementation is
 * single-threaded and extra lanes would add latency without adding parallel
 * hardware. It is above OWASP's Argon2id floor (19 MiB, t=2, p=1).
 *
 * Cost and latency trade-off: a derivation runs on every unlock. Measured on
 * the CI-class box this lane was built on, one production derivation takes
 * about 1.2 s in Node 22 with @noble/hashes; browsers are typically 1.5-3x
 * slower than Node for this code, and phones slower again, so expect roughly
 * 2-4 s on a mid-range laptop browser. 64 MiB is the most a low-memory mobile
 * browser tab can be expected to allocate without being killed; going higher
 * buys attacker cost at the risk of failed unlocks. The async variant yields to
 * the event loop so the UI stays responsive while it runs.
 *
 * The parameters are stored with each wrapped key, so they can be raised for
 * new wraps later without breaking old ones. Argon2id hashes them into its
 * initial block, so a stored record whose parameters were lowered derives a
 * different key and fails to unwrap.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';

import { EnvelopeError } from './errors';

export interface KdfParams {
  readonly algorithm: 'argon2id';
  /** Passes over memory (Argon2 `t`). */
  readonly iterations: number;
  /** Memory in KiB (Argon2 `m`). */
  readonly memoryKiB: number;
  /** Lanes (Argon2 `p`). */
  readonly parallelism: number;
}

const PRODUCTION_ITERATIONS = 3;
const PRODUCTION_MEMORY_KIB = 64 * 1024;
const PRODUCTION_PARALLELISM = 1;

export const PRODUCTION_KDF_PARAMS: KdfParams = Object.freeze({
  algorithm: 'argon2id',
  iterations: PRODUCTION_ITERATIONS,
  memoryKiB: PRODUCTION_MEMORY_KIB,
  parallelism: PRODUCTION_PARALLELISM,
});

export const KDF_SALT_BYTES = 16;
export const DERIVED_KEY_BYTES = 32;

/** Optional Argon2 inputs, used only by the RFC 9106 known-answer test. */
export interface Argon2Extras {
  readonly secret?: Uint8Array;
  readonly associatedData?: Uint8Array;
}

/** Derive a 256-bit key with Argon2id; any parameter the algorithm refuses is `invalid_input`. */
export async function deriveArgon2id(
  secret: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
  extras: Argon2Extras = {},
): Promise<Uint8Array> {
  try {
    return await argon2idAsync(secret, salt, {
      t: params.iterations,
      m: params.memoryKiB,
      p: params.parallelism,
      dkLen: DERIVED_KEY_BYTES,
      key: extras.secret,
      personalization: extras.associatedData,
    });
  } catch {
    throw new EnvelopeError('invalid_input');
  }
}

/** A fresh random salt for one wrap. */
export function randomSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
}
