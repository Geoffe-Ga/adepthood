/**
 * Key-wrapping core, parameterised by a KDF floor. Internal: only
 * keyHierarchy.ts (which pins the floor to PRODUCTION_KDF_PARAMS) and the
 * test-only seam under __tests__/ may import it, which cryptoUnreachable.test.ts
 * enforces. See keyHierarchy.ts for the design.
 */
import { openBound, sealBound, type AadField } from './envelope';
import { EnvelopeError, requireInput } from './errors';
import {
  KDF_SALT_BYTES,
  PRODUCTION_KDF_PARAMS,
  assertKdfParamsWithin,
  deriveArgon2id,
  randomSalt,
  type KdfParams,
} from './kdf';
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
  /** Defaults to PRODUCTION_KDF_PARAMS; anything below the hierarchy's floor is refused. */
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

async function unwrapOne(
  wrapped: WrappedDataKey,
  purpose: WrapPurpose,
  secret: Uint8Array,
  request: UnwrapCommon,
  floor: KdfParams,
): Promise<Uint8Array> {
  assertKdfParamsWithin(wrapped.kdf, floor);
  if (wrapped.salt.length !== KDF_SALT_BYTES) {
    throw new EnvelopeError('malformed');
  }
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

export interface KeyHierarchy {
  /** Wrap the data key under the passphrase and, separately, under the recovery phrase. */
  readonly wrapDataKey: (request: WrapRequest) => Promise<WrappedDataKeys>;
  /** Unwrap the data key with the passphrase. */
  readonly unwrapWithPassphrase: (
    wrapped: WrappedDataKey,
    request: PassphraseUnwrap,
  ) => Promise<Uint8Array>;
  /** Unwrap the data key with the recovery phrase (normalised and checksum-validated first). */
  readonly unwrapWithRecoveryPhrase: (
    wrapped: WrappedDataKey,
    request: RecoveryPhraseUnwrap,
  ) => Promise<Uint8Array>;
}

/**
 * The wrap and unwrap operations with every KDF parameter set, requested or
 * stored, checked against `floor` and the named ceilings before deriving.
 * A wrap's default parameters are always PRODUCTION_KDF_PARAMS.
 */
export function keyHierarchyWithFloor(floor: KdfParams): KeyHierarchy {
  return {
    wrapDataKey: async (request) => {
      requireInput(request.dataKey.length === DATA_KEY_BYTES);
      const kdf = request.kdfParams ?? PRODUCTION_KDF_PARAMS;
      assertKdfParamsWithin(kdf, floor);
      const passphrase = await wrapOne(
        request,
        'passphrase',
        passphraseBytes(request.passphrase),
        kdf,
      );
      const recoveryPhrase = await wrapOne(
        request,
        'recovery-phrase',
        recoveryPhraseBytes(request.recoveryPhrase),
        kdf,
      );
      return { passphrase, recoveryPhrase };
    },
    unwrapWithPassphrase: async (wrapped, request) =>
      await unwrapOne(wrapped, 'passphrase', passphraseBytes(request.passphrase), request, floor),
    unwrapWithRecoveryPhrase: async (wrapped, request) =>
      await unwrapOne(
        wrapped,
        'recovery-phrase',
        recoveryPhraseBytes(request.recoveryPhrase),
        request,
        floor,
      ),
  };
}
