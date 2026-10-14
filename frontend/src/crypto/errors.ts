/**
 * The one error the client crypto module throws.
 *
 * Every failure is reported by a fixed `code` and a fixed message chosen from
 * that code alone. No message is ever built from an input, so no plaintext,
 * key, passphrase, recovery phrase or binding (owner, object id) can reach an
 * error, a log line or an error reporter through this type. Library errors are
 * swallowed and replaced, never chained as `cause`, for the same reason.
 */

export type EnvelopeFailure =
  /** The bytes are not a well-formed envelope (too short, version out of range). */
  | 'malformed'
  /** The envelope's format version is not one this build can open. */
  | 'unsupported_format'
  /** The envelope is bound to an older version than the caller requires. */
  | 'rollback'
  /** Wrong key, or the ciphertext, nonce, tag or any bound field was altered. */
  | 'authentication_failed'
  /** The recovery phrase fails the wordlist or checksum. */
  | 'invalid_recovery_phrase'
  /** KDF parameters outside the named floor and ceiling (a weak wrap or a tampered record). */
  | 'kdf_out_of_bounds'
  /** The caller passed an argument the module refuses to seal or derive with. */
  | 'invalid_input';

const MESSAGES: Readonly<Record<EnvelopeFailure, string>> = {
  malformed: 'Encrypted data is malformed.',
  unsupported_format: 'Encrypted data uses an unsupported format version.',
  rollback: 'Encrypted data is older than the required version.',
  authentication_failed: 'Encrypted data could not be authenticated.',
  invalid_recovery_phrase: 'Recovery phrase is not valid.',
  kdf_out_of_bounds: 'Key derivation parameters are outside the allowed range.',
  invalid_input: 'Invalid input to the encryption module.',
};

export class EnvelopeError extends Error {
  readonly code: EnvelopeFailure;

  constructor(code: EnvelopeFailure) {
    super(MESSAGES[code]);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

/** Throw a content-free `invalid_input` unless `condition` holds. */
export function requireInput(condition: boolean): asserts condition {
  if (!condition) {
    throw new EnvelopeError('invalid_input');
  }
}
