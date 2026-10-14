/**
 * Versioned AEAD envelope, format v1 (ADR 0009 phase (b); B13).
 *
 * Byte layout of a v1 envelope:
 *
 *   offset  length  field
 *   0       1       format version (0x01)
 *   1       8       bound version, unsigned 64-bit big-endian
 *   9       24      XChaCha20-Poly1305 nonce, fresh random per seal
 *   33      n       ciphertext (same length as the plaintext)
 *   33+n    16      Poly1305 tag
 *
 * The header (format and bound version) travels in the clear so a reader can
 * check it before decrypting, and is authenticated because both values are
 * also encoded into the AAD. The AAD itself is never stored: the opener
 * rebuilds it from what it expects (owner, object type, object id), so a row
 * swapped in from another object or another account fails authentication.
 *
 * AAD encoding (canonical, length-prefixed, never string concatenation):
 *
 *   lp("adepthood.envelope") || u8(format) || lp(domain)
 *     || u32(field count) || lp(field_1) || ... || lp(field_k) || u64(bound version)
 *
 * where lp(x) = u32 big-endian byte length of x, then x; strings are UTF-8.
 * Object envelopes use domain "object" with fields [owner id, object type,
 * object id]. Key wraps (keyHierarchy.ts) use domain "key-wrap".
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { EnvelopeError, requireInput } from './errors';

export const ENVELOPE_FORMAT_V1 = 1;

const AAD_LABEL = 'adepthood.envelope';
const OBJECT_DOMAIN = 'object';
const KEY_BYTES = 32;
const FORMAT_BYTES = 1;
const VERSION_BYTES = 8;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const LENGTH_PREFIX_BYTES = 4;

export const ENVELOPE_V1_LAYOUT = Object.freeze({
  formatOffset: 0,
  versionOffset: FORMAT_BYTES,
  nonceOffset: FORMAT_BYTES + VERSION_BYTES,
  ciphertextOffset: FORMAT_BYTES + VERSION_BYTES + NONCE_BYTES,
  nonceBytes: NONCE_BYTES,
  tagBytes: TAG_BYTES,
  minimumLength: FORMAT_BYTES + VERSION_BYTES + NONCE_BYTES + TAG_BYTES,
});

/** What a sealed object is bound to. */
export interface ObjectBinding {
  readonly ownerId: string;
  readonly objectType: string;
  readonly objectId: string;
  /** Monotonic per-object version; a reader refuses anything below its minimum. */
  readonly objectVersion: number;
}

/** What an opener requires: the same owner, type and id, at or above `minVersion`. */
export interface ObjectExpectation {
  readonly ownerId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly minVersion: number;
}

export interface OpenedObject {
  readonly plaintext: Uint8Array;
  readonly objectVersion: number;
}

export type AadField = string | Uint8Array;

const utf8 = new TextEncoder();

function toBytes(field: AadField): Uint8Array {
  return typeof field === 'string' ? utf8.encode(field) : field;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(LENGTH_PREFIX_BYTES);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(VERSION_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthPrefixed(field: AadField): Uint8Array[] {
  const bytes = toBytes(field);
  return [u32(bytes.length), bytes];
}

const isVersion = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** The canonical v1 AAD for `domain`, its ordered `fields`, and the bound version. */
export function encodeAad(
  domain: string,
  fields: readonly AadField[],
  boundVersion: number,
): Uint8Array {
  return concat([
    ...lengthPrefixed(AAD_LABEL),
    Uint8Array.of(ENVELOPE_FORMAT_V1),
    ...lengthPrefixed(domain),
    u32(fields.length),
    ...fields.flatMap(lengthPrefixed),
    u64(boundVersion),
  ]);
}

/** The bare AEAD open, mapping any library failure to a content-free error. */
export function openRaw(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(sealed);
  } catch {
    throw new EnvelopeError('authentication_failed');
  }
}

function randomNonce(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

function requireBoundInputs(key: Uint8Array, fields: readonly AadField[], version: number): void {
  requireInput(key.length === KEY_BYTES);
  requireInput(isVersion(version));
  requireInput(fields.every((field) => toBytes(field).length > 0));
}

/** Seal `plaintext` under `key`, bound to `domain`, `fields` and `boundVersion`. */
export function sealBound(
  key: Uint8Array,
  plaintext: Uint8Array,
  domain: string,
  fields: readonly AadField[],
  boundVersion: number,
): Uint8Array {
  requireBoundInputs(key, fields, boundVersion);
  const nonce = randomNonce();
  const aad = encodeAad(domain, fields, boundVersion);
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concat([Uint8Array.of(ENVELOPE_FORMAT_V1), u64(boundVersion), nonce, sealed]);
}

function readHeader(envelope: Uint8Array): number {
  if (envelope.length < FORMAT_BYTES) {
    throw new EnvelopeError('malformed');
  }
  if (envelope[ENVELOPE_V1_LAYOUT.formatOffset] !== ENVELOPE_FORMAT_V1) {
    throw new EnvelopeError('unsupported_format');
  }
  if (envelope.length < ENVELOPE_V1_LAYOUT.minimumLength) {
    throw new EnvelopeError('malformed');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const version = view.getBigUint64(ENVELOPE_V1_LAYOUT.versionOffset);
  if (version > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EnvelopeError('malformed');
  }
  return Number(version);
}

/**
 * Open an envelope sealed by `sealBound`. Checks, in order: format version,
 * length, rollback (bound version below `minVersion`), then authentication of
 * the ciphertext against the AAD rebuilt from the caller's expectation.
 */
export function openBound(
  key: Uint8Array,
  envelope: Uint8Array,
  domain: string,
  fields: readonly AadField[],
  minVersion: number,
): { plaintext: Uint8Array; boundVersion: number } {
  requireBoundInputs(key, fields, minVersion);
  const boundVersion = readHeader(envelope);
  if (boundVersion < minVersion) {
    throw new EnvelopeError('rollback');
  }
  const { nonceOffset, ciphertextOffset } = ENVELOPE_V1_LAYOUT;
  const plaintext = openRaw(
    key,
    envelope.subarray(nonceOffset, ciphertextOffset),
    envelope.subarray(ciphertextOffset),
    encodeAad(domain, fields, boundVersion),
  );
  return { plaintext, boundVersion };
}

/** Seal one stored object, bound to its owner, type, id and version. */
export function sealObject(
  key: Uint8Array,
  plaintext: Uint8Array,
  binding: ObjectBinding,
): Uint8Array {
  return sealBound(
    key,
    plaintext,
    OBJECT_DOMAIN,
    [binding.ownerId, binding.objectType, binding.objectId],
    binding.objectVersion,
  );
}

/** Open one stored object; fails closed unless it matches `expected` exactly. */
export function openObject(
  key: Uint8Array,
  envelope: Uint8Array,
  expected: ObjectExpectation,
): OpenedObject {
  const { plaintext, boundVersion } = openBound(
    key,
    envelope,
    OBJECT_DOMAIN,
    [expected.ownerId, expected.objectType, expected.objectId],
    expected.minVersion,
  );
  return { plaintext, objectVersion: boundVersion };
}
