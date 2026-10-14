import { describe, expect, it } from '@jest/globals';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { openRaw } from '../envelope';
import { deriveArgon2id } from '../kdf';

/**
 * Known-answer vectors from the primitives' published specifications, so a
 * library swap or a mis-wired parameter cannot pass on round-trips alone.
 */

// draft-irtf-cfrg-xchacha-03, Appendix A.3.1 (AEAD_XChaCha20_Poly1305).
const XCHACHA_KEY_FIRST_BYTE = 0x80;
const XCHACHA_NONCE_FIRST_BYTE = 0x40;
const XCHACHA_KEY_BYTES = 32;
const XCHACHA_NONCE_BYTES = 24;
/** The vector's key is the bytes 0x80..0x9f and its nonce 0x40..0x57. */
const byteRun = (first: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => first + i);
const XCHACHA_KEY = byteRun(XCHACHA_KEY_FIRST_BYTE, XCHACHA_KEY_BYTES);
const XCHACHA_NONCE = byteRun(XCHACHA_NONCE_FIRST_BYTE, XCHACHA_NONCE_BYTES);
const XCHACHA_AAD = '50515253c0c1c2c3c4c5c6c7';
const XCHACHA_PLAINTEXT =
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
const XCHACHA_CIPHERTEXT =
  'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' + // pragma: allowlist secret -- published test vector, not a secret
  '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' + // pragma: allowlist secret -- published test vector, not a secret
  '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' + // pragma: allowlist secret -- published test vector, not a secret
  '21f9664c97637da9768812f615c68b13b52e'; // pragma: allowlist secret -- published test vector, not a secret
const XCHACHA_TAG = 'c0875924c1c7987947deafd8780acf49'; // pragma: allowlist secret -- published test vector, not a secret

// RFC 9106, Section 5.3 (Argon2id test vector).
const ARGON2ID_PASSWORD_BYTE = 0x01;
const ARGON2ID_PASSWORD_LENGTH = 32;
const ARGON2ID_SALT_BYTE = 0x02;
const ARGON2ID_SALT_LENGTH = 16;
const ARGON2ID_SECRET_BYTE = 0x03;
const ARGON2ID_SECRET_LENGTH = 8;
const ARGON2ID_AD_BYTE = 0x04;
const ARGON2ID_AD_LENGTH = 12;
const ARGON2ID_TAG = '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'; // pragma: allowlist secret -- published test vector, not a secret

describe('known-answer vectors', () => {
  it('XChaCha20-Poly1305 reproduces draft-irtf-cfrg-xchacha-03 A.3.1', () => {
    const sealed = xchacha20poly1305(XCHACHA_KEY, XCHACHA_NONCE, hexToBytes(XCHACHA_AAD)).encrypt(
      utf8ToBytes(XCHACHA_PLAINTEXT),
    );

    expect(bytesToHex(sealed)).toBe(XCHACHA_CIPHERTEXT + XCHACHA_TAG);
  });

  it("the envelope's AEAD layer opens the published vector", () => {
    const opened = openRaw(
      XCHACHA_KEY,
      XCHACHA_NONCE,
      hexToBytes(XCHACHA_CIPHERTEXT + XCHACHA_TAG),
      hexToBytes(XCHACHA_AAD),
    );

    expect(new TextDecoder().decode(opened)).toBe(XCHACHA_PLAINTEXT);
  });

  it("Argon2id reproduces RFC 9106 section 5.3 through the module's KDF", async () => {
    const tag = await deriveArgon2id(
      new Uint8Array(ARGON2ID_PASSWORD_LENGTH).fill(ARGON2ID_PASSWORD_BYTE),
      new Uint8Array(ARGON2ID_SALT_LENGTH).fill(ARGON2ID_SALT_BYTE),
      { algorithm: 'argon2id', iterations: 3, memoryKiB: 32, parallelism: 4 },
      {
        secret: new Uint8Array(ARGON2ID_SECRET_LENGTH).fill(ARGON2ID_SECRET_BYTE),
        associatedData: new Uint8Array(ARGON2ID_AD_LENGTH).fill(ARGON2ID_AD_BYTE),
      },
    );

    expect(bytesToHex(tag)).toBe(ARGON2ID_TAG);
  });
});
