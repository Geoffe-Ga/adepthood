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

/**
 * Ceilings on stored parameters. A wrapped-key record is server-side data, and
 * the server is an adversary in this threat model: without a ceiling, a record
 * with t = 2^31 never finishes deriving (the async KDF yields, so the UI stays
 * live while the unlock spins forever), and one with m near 4 GiB tries an
 * allocation that kills a mobile tab. Either locks the person out.
 *
 * - 256 MiB is four times production memory: room to raise the cost later,
 *   and about the most a desktop browser tab can allocate reliably.
 * - 10 passes is just over three times production.
 * - Total work (passes x KiB) is capped at four times production, about 5-6 s
 *   in Node 22, so the two ceilings cannot be combined into a ~40 s unlock.
 */
export const MAX_KDF_ITERATIONS = 10;
export const MAX_KDF_MEMORY_KIB = 256 * 1024;
const MAX_KDF_WORK_FACTOR = 4;
export const MAX_KDF_WORK_KIB_PASSES =
  MAX_KDF_WORK_FACTOR * PRODUCTION_ITERATIONS * PRODUCTION_MEMORY_KIB;
/** The pure-JS implementation is single-threaded, so only one lane is accepted. */
const KDF_PARALLELISM = PRODUCTION_PARALLELISM;

const within = (value: number, floor: number, ceiling: number): boolean =>
  Number.isSafeInteger(value) && value >= floor && value <= ceiling;

/**
 * Throw a content-free `kdf_out_of_bounds` unless `params` are Argon2id with
 * one lane, at or above `floor`, and at or below the named ceilings. Runs
 * before any derivation, so a hostile record fails fast.
 */
export function assertKdfParamsWithin(params: KdfParams, floor: KdfParams): void {
  const acceptable = [
    params.algorithm === 'argon2id',
    params.parallelism === KDF_PARALLELISM,
    within(params.iterations, floor.iterations, MAX_KDF_ITERATIONS),
    within(params.memoryKiB, floor.memoryKiB, MAX_KDF_MEMORY_KIB),
    params.iterations * params.memoryKiB <= MAX_KDF_WORK_KIB_PASSES,
  ].every(Boolean);
  if (!acceptable) {
    throw new EnvelopeError('kdf_out_of_bounds');
  }
}
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
