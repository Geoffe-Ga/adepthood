/** Client-only implementation of Creek's language-neutral key ceremony 1.0.0. */

import { gcm } from '@noble/ciphers/aes.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytesAsync } from 'expo-crypto';

const PROTOCOL_VERSION = '1.0.0' as const;
const KEY_VAULT_VERSION = 2 as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const ARGON_TIME_COST = 3 as const;
const ARGON_MEMORY_KIB = 65_536 as const;
const ARGON_LANES = 4 as const;
const ARGON_MAX_MEMORY_BYTES = 96 * 1024 * 1024;
const PASSPHRASE_AAD_DOMAIN = 'creek.confidential.vmk.passphrase.v1';
const RECOVERY_AAD_DOMAIN = 'creek.confidential.vmk.recovery.v1';
const RECOVERY_KEK_INFO = utf8ToBytes('creek.confidential.recovery-kek.v1');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // pragma: allowlist secret
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // pragma: allowlist secret
const INVALID_RECOVERY_CODE = 'recovery code is invalid';

export type CeremonyBinding = {
  protocol_version: typeof PROTOCOL_VERSION;
  activation_id: string;
  ceremony_id: string;
  server_nonce: string;
  client_nonce: string;
};

export type KeyCeremonyChallenge = {
  protocol_version: typeof PROTOCOL_VERSION;
  job_id: string;
  activation_id: string;
  ceremony_id: string;
  server_nonce: string;
  expires_at: string;
};

type WrappedCiphertext = {
  nonce: string;
  ciphertext: string;
};

export type WrappedKeyArtifact = {
  version: typeof KEY_VAULT_VERSION;
  kdf: {
    algorithm: 'argon2id';
    salt: string;
    time_cost: typeof ARGON_TIME_COST;
    lanes: typeof ARGON_LANES;
    memory_kib: typeof ARGON_MEMORY_KIB;
  };
  passphrase_wrapped: WrappedCiphertext;
  recovery_wrapped: WrappedCiphertext;
  binding: CeremonyBinding;
};

export type WrappedArtifactInputs = {
  binding: CeremonyBinding;
  passphrase: string;
  recoveryValue: Uint8Array;
  volumeMasterKey: Uint8Array;
  salt: Uint8Array;
  passphraseNonce: Uint8Array;
  recoveryNonce: Uint8Array;
};

export type PreparedKeyCeremony = {
  recoveryCode: string;
  wrappedArtifact: WrappedKeyArtifact;
};

export class KeyCeremonyError extends Error {
  constructor(message = 'key ceremony failed') {
    super(message);
    this.name = 'KeyCeremonyError';
  }
}

function requireLength(value: Uint8Array, length: number): void {
  if (value.length !== length) throw new KeyCeremonyError();
}

function canonicalBinding(binding: CeremonyBinding): string {
  return JSON.stringify({
    activation_id: binding.activation_id,
    ceremony_id: binding.ceremony_id,
    client_nonce: binding.client_nonce,
    protocol_version: binding.protocol_version,
    server_nonce: binding.server_nonce,
  });
}

function associatedData(domain: string, binding: CeremonyBinding): Uint8Array {
  return concatBytes(utf8ToBytes(domain), Uint8Array.of(0), utf8ToBytes(canonicalBinding(binding)));
}

function toBase64Url(value: Uint8Array): string {
  let output = '';
  for (let offset = 0; offset < value.length; offset += 3) {
    const first = value[offset] ?? 0;
    const second = value[offset + 1];
    const third = value[offset + 2];
    output += BASE64URL_ALPHABET[first >>> 2];
    output += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      output += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) output += BASE64URL_ALPHABET[third & 63];
  }
  return output;
}

function toBase32(value: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function formatRecoveryCode(recoveryValue: Uint8Array): string {
  requireLength(recoveryValue, KEY_LENGTH);
  return (
    toBase32(recoveryValue)
      .match(/.{1,5}/gu)
      ?.join('-') ?? ''
  );
}

export function recoveryCodeToBytes(recoveryCode: string): Uint8Array {
  if (!/^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){9}-[A-Z2-7]{2}$/u.test(recoveryCode)) {
    throw new KeyCeremonyError(INVALID_RECOVERY_CODE);
  }
  const normalized = recoveryCode.replaceAll('-', '');
  const output = new Uint8Array(KEY_LENGTH);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) throw new KeyCeremonyError(INVALID_RECOVERY_CODE);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (offset < output.length) output[offset] = (buffer >>> bits) & 0xff;
      offset += 1;
    }
  }
  if (offset !== KEY_LENGTH || (buffer & ((1 << bits) - 1)) !== 0) {
    throw new KeyCeremonyError(INVALID_RECOVERY_CODE);
  }
  return output;
}

function recoveryKek(recoveryValue: Uint8Array): Uint8Array {
  return hkdf(sha256, recoveryValue, undefined, RECOVERY_KEK_INFO, KEY_LENGTH);
}

async function passphraseKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  if (passphrase.length === 0) throw new KeyCeremonyError('passphrase is required');
  return argon2idAsync(utf8ToBytes(passphrase), salt, {
    t: ARGON_TIME_COST,
    m: ARGON_MEMORY_KIB,
    p: ARGON_LANES,
    dkLen: KEY_LENGTH,
    maxmem: ARGON_MAX_MEMORY_BYTES,
    asyncTick: 8,
  });
}

export async function deriveWrappedKeyArtifact(
  inputs: WrappedArtifactInputs,
): Promise<WrappedKeyArtifact> {
  requireLength(inputs.volumeMasterKey, KEY_LENGTH);
  requireLength(inputs.recoveryValue, KEY_LENGTH);
  requireLength(inputs.salt, SALT_LENGTH);
  requireLength(inputs.passphraseNonce, NONCE_LENGTH);
  requireLength(inputs.recoveryNonce, NONCE_LENGTH);
  const passphraseKey = await passphraseKek(inputs.passphrase, inputs.salt);
  const recoveryKey = recoveryKek(inputs.recoveryValue);
  try {
    const passphraseCiphertext = gcm(
      passphraseKey,
      inputs.passphraseNonce,
      associatedData(PASSPHRASE_AAD_DOMAIN, inputs.binding),
    ).encrypt(inputs.volumeMasterKey);
    const recoveryCiphertext = gcm(
      recoveryKey,
      inputs.recoveryNonce,
      associatedData(RECOVERY_AAD_DOMAIN, inputs.binding),
    ).encrypt(inputs.volumeMasterKey);
    return {
      version: KEY_VAULT_VERSION,
      kdf: {
        algorithm: 'argon2id',
        salt: bytesToHex(inputs.salt),
        time_cost: ARGON_TIME_COST,
        lanes: ARGON_LANES,
        memory_kib: ARGON_MEMORY_KIB,
      },
      passphrase_wrapped: {
        nonce: bytesToHex(inputs.passphraseNonce),
        ciphertext: bytesToHex(passphraseCiphertext),
      },
      recovery_wrapped: {
        nonce: bytesToHex(inputs.recoveryNonce),
        ciphertext: bytesToHex(recoveryCiphertext),
      },
      binding: inputs.binding,
    };
  } finally {
    passphraseKey.fill(0);
    recoveryKey.fill(0);
  }
}

export async function prepareKeyCeremony(
  challenge: KeyCeremonyChallenge,
  passphrase: string,
): Promise<PreparedKeyCeremony> {
  if (challenge.protocol_version !== PROTOCOL_VERSION) throw new KeyCeremonyError();
  const volumeMasterKey = await getRandomBytesAsync(KEY_LENGTH);
  const recoveryValue = await getRandomBytesAsync(KEY_LENGTH);
  const salt = await getRandomBytesAsync(SALT_LENGTH);
  const clientNonce = await getRandomBytesAsync(KEY_LENGTH);
  const passphraseNonce = await getRandomBytesAsync(NONCE_LENGTH);
  const recoveryNonce = await getRandomBytesAsync(NONCE_LENGTH);
  try {
    const wrappedArtifact = await deriveWrappedKeyArtifact({
      binding: {
        protocol_version: PROTOCOL_VERSION,
        activation_id: challenge.activation_id,
        ceremony_id: challenge.ceremony_id,
        server_nonce: challenge.server_nonce,
        client_nonce: toBase64Url(clientNonce),
      },
      passphrase,
      recoveryValue,
      volumeMasterKey,
      salt,
      passphraseNonce,
      recoveryNonce,
    });
    return { recoveryCode: formatRecoveryCode(recoveryValue), wrappedArtifact };
  } finally {
    volumeMasterKey.fill(0);
    recoveryValue.fill(0);
    salt.fill(0);
    clientNonce.fill(0);
    passphraseNonce.fill(0);
    recoveryNonce.fill(0);
  }
}

export async function unwrapWithPassphrase(
  artifact: WrappedKeyArtifact,
  passphrase: string,
): Promise<Uint8Array> {
  const key = await passphraseKek(passphrase, hexToBytes(artifact.kdf.salt));
  try {
    return gcm(
      key,
      hexToBytes(artifact.passphrase_wrapped.nonce),
      associatedData(PASSPHRASE_AAD_DOMAIN, artifact.binding),
    ).decrypt(hexToBytes(artifact.passphrase_wrapped.ciphertext));
  } catch {
    throw new KeyCeremonyError('key ceremony unwrap failed');
  } finally {
    key.fill(0);
  }
}

export function unwrapWithRecoveryCode(
  artifact: WrappedKeyArtifact,
  recoveryCode: string,
): Uint8Array {
  const recoveryValue = recoveryCodeToBytes(recoveryCode);
  const key = recoveryKek(recoveryValue);
  try {
    return gcm(
      key,
      hexToBytes(artifact.recovery_wrapped.nonce),
      associatedData(RECOVERY_AAD_DOMAIN, artifact.binding),
    ).decrypt(hexToBytes(artifact.recovery_wrapped.ciphertext));
  } catch {
    throw new KeyCeremonyError('key ceremony unwrap failed');
  } finally {
    recoveryValue.fill(0);
    key.fill(0);
  }
}
