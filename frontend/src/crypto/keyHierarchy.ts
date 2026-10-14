/**
 * Key hierarchy (ADR 0009 phase (b), Decision item 11).
 *
 * One random 256-bit data key per account, generated on the device. It is
 * wrapped twice: once under a key derived from the person's passphrase and once
 * under a key derived from their recovery phrase. Either factor unwraps the
 * same data key; losing both loses the data, by design (no escrow).
 *
 * Each wrap is itself a v1 envelope (envelope.ts) in the "key-wrap" domain,
 * whose AAD binds the wrap purpose and the owner.
 * Its bound version is the wrap version, so a replayed older wrap (say, under a
 * passphrase the person has since changed) is refused by the rollback check.
 *
 * This module provides building blocks only. It exports no enrolment flow,
 * and nothing in the app imports it (see cryptoUnreachable.test.ts): no real
 * account may enrol until the review gate in ADR 0009 is met.
 */
import { openBound, sealBound, type AadField } from './envelope';
import { requireInput } from './errors';
import { PRODUCTION_KDF_PARAMS, deriveArgon2id, randomSalt, type KdfParams } from './kdf';
import { assertValidRecoveryPhrase, normaliseRecoveryPhrase } from './recoveryPhrase';

export const DATA_KEY_BYTES = 32;

const KEY_WRAP_DOMAIN = 'key-wrap';

export type WrapPurpose = 'passphrase' | 'recovery-phrase';

/** One stored wrap of the data key. Safe to store server-side: it holds no secret. */
export interface WrappedDataKey {
  readonly purpose: WrapPurpose;
  readonly kdf: KdfParams;
  readonly salt: Uint8Array;
  readonly envelope: Uint8Array;
}

export interface WrappedDataKeys {
  readonly passphrase: WrappedDataKey;
  readonly recoveryPhrase: WrappedDataKey;
}

export interface WrapRequest {
  readonly dataKey: Uint8Array;
  readonly ownerId: string;
  readonly passphrase: string;
  readonly recoveryPhrase: string;
  readonly wrapVersion: number;
  /** Defaults to PRODUCTION_KDF_PARAMS; tests inject a cheaper set explicitly. */
  readonly kdfParams?: KdfParams;
}

interface UnwrapCommon {
  readonly ownerId: string;
  readonly minWrapVersion: number;
}

export interface PassphraseUnwrap extends UnwrapCommon {
  readonly passphrase: string;
}

export interface RecoveryPhraseUnwrap extends UnwrapCommon {
  readonly recoveryPhrase: string;
}

const utf8 = new TextEncoder();

/** A fresh 256-bit data key from WebCrypto getRandomValues. */
export function generateDataKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
}

/** NFC, so the same passphrase typed with a different composition derives the same key. */
function passphraseBytes(passphrase: string): Uint8Array {
  const bytes = utf8.encode(passphrase.normalize('NFC'));
  requireInput(bytes.length > 0);
  return bytes;
}

function recoveryPhraseBytes(phrase: string): Uint8Array {
  const normalised = normaliseRecoveryPhrase(phrase);
  assertValidRecoveryPhrase(normalised);
  return utf8.encode(normalised);
}

/**
 * The wrap AAD binds purpose and owner. The KDF parameters and salt are not
 * repeated here: Argon2id already hashes t, m, p and the salt into its initial
 * block (RFC 9106 section 3.2), so a record whose parameters or salt were
 * altered derives a different wrapping key and fails authentication anyway.
 */
function wrapFields(purpose: WrapPurpose, ownerId: string): AadField[] {
  return [purpose, ownerId];
}

async function wrapOne(
  request: WrapRequest,
  purpose: WrapPurpose,
  secret: Uint8Array,
  kdf: KdfParams,
): Promise<WrappedDataKey> {
  const salt = randomSalt();
  const wrappingKey = await deriveArgon2id(secret, salt, kdf);
  const envelope = sealBound(
    wrappingKey,
    request.dataKey,
    KEY_WRAP_DOMAIN,
    wrapFields(purpose, request.ownerId),
    request.wrapVersion,
  );
  return { purpose, kdf, salt, envelope };
}

/** Wrap the data key under the passphrase and, separately, under the recovery phrase. */
export async function wrapDataKey(request: WrapRequest): Promise<WrappedDataKeys> {
  requireInput(request.dataKey.length === DATA_KEY_BYTES);
  const kdf = request.kdfParams ?? PRODUCTION_KDF_PARAMS;
  const passphrase = await wrapOne(request, 'passphrase', passphraseBytes(request.passphrase), kdf);
  const recoveryPhrase = await wrapOne(
    request,
    'recovery-phrase',
    recoveryPhraseBytes(request.recoveryPhrase),
    kdf,
  );
  return { passphrase, recoveryPhrase };
}

async function unwrapOne(
  wrapped: WrappedDataKey,
  purpose: WrapPurpose,
  secret: Uint8Array,
  request: UnwrapCommon,
): Promise<Uint8Array> {
  const wrappingKey = await deriveArgon2id(secret, wrapped.salt, wrapped.kdf);
  const { plaintext } = openBound(
    wrappingKey,
    wrapped.envelope,
    KEY_WRAP_DOMAIN,
    wrapFields(purpose, request.ownerId),
    request.minWrapVersion,
  );
  return plaintext;
}

/** Unwrap the data key with the passphrase. */
export async function unwrapWithPassphrase(
  wrapped: WrappedDataKey,
  request: PassphraseUnwrap,
): Promise<Uint8Array> {
  return await unwrapOne(wrapped, 'passphrase', passphraseBytes(request.passphrase), request);
}

/** Unwrap the data key with the recovery phrase (normalised and checksum-validated first). */
export async function unwrapWithRecoveryPhrase(
  wrapped: WrappedDataKey,
  request: RecoveryPhraseUnwrap,
): Promise<Uint8Array> {
  return await unwrapOne(
    wrapped,
    'recovery-phrase',
    recoveryPhraseBytes(request.recoveryPhrase),
    request,
  );
}
