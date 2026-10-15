/**
 * Key hierarchy (ADR 0009 phase (b), Decision item 11).
 *
 * One random 256-bit data key per account, generated on the device. It is
 * wrapped twice: once under a key derived from the person's passphrase and once
 * under a key derived from their recovery phrase. Either factor unwraps the
 * same data key; losing both loses the data, by design (no escrow).
 *
 * Each wrap is itself a v1 envelope (envelope.ts) in the "key-wrap" domain,
 * whose AAD binds the wrap purpose and the owner. Its bound version is the wrap
 * version, so a replayed older wrap (say, under a passphrase the person has
 * since changed) is refused by the rollback check.
 *
 * This public API is pinned to the production KDF floor: a wrap below
 * PRODUCTION_KDF_PARAMS is refused, and so is a stored record below that floor
 * or above the named ceilings (kdf.ts), before any derivation runs. Tests reach
 * a cheaper floor only through the explicit seam in __tests__/.
 *
 * This module provides building blocks only. It exports no enrolment flow,
 * and nothing in the app imports it (see cryptoUnreachable.test.ts): no real
 * account may enrol until the review gate in ADR 0009 is met.
 */
import { PRODUCTION_KDF_PARAMS } from './kdf';
import { keyHierarchyWithFloor } from './wrapCore';

export {
  DATA_KEY_BYTES,
  generateDataKey,
  type PassphraseUnwrap,
  type RecoveryPhraseUnwrap,
  type WrapPurpose,
  type WrapRequest,
  type WrappedDataKey,
  type WrappedDataKeys,
} from './wrapCore';

const production = keyHierarchyWithFloor(PRODUCTION_KDF_PARAMS);

/** Wrap the data key under the passphrase and the recovery phrase, at or above production cost. */
export const wrapDataKey = production.wrapDataKey;
/** Unwrap the data key with the passphrase; refuses a record outside the production bounds. */
export const unwrapWithPassphrase = production.unwrapWithPassphrase;
/** Unwrap the data key with the recovery phrase; refuses a record outside the production bounds. */
export const unwrapWithRecoveryPhrase = production.unwrapWithRecoveryPhrase;
