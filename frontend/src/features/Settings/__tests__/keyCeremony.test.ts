/* global describe, it, expect */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import vector from '../key-ceremony-test-vectors.json';
import {
  deriveWrappedKeyArtifact,
  prepareKeyCeremony,
  recoveryCodeToBytes,
  unwrapWithPassphrase,
  unwrapWithRecoveryCode,
} from '../keyCeremony';

// These tests deliberately exercise the production Argon2id work factor. The
// language-neutral vector derives twice, and a full parallel Jest run can put
// it above the default 30-second ceiling even though the bytes remain stable.
const PRODUCTION_KDF_TIMEOUT_MS = 120_000;

describe('Creek key ceremony 1.0.0 interoperability', () => {
  it(
    'derives and unwraps Creek’s checked-in language-neutral vector byte for byte',
    async () => {
      const binding = {
        protocol_version: '1.0.0' as const,
        activation_id: vector.binding.activation_id,
        ceremony_id: vector.binding.ceremony_id,
        server_nonce: vector.binding.server_nonce,
        client_nonce: vector.binding.client_nonce,
      };
      const artifact = await deriveWrappedKeyArtifact({
        binding,
        passphrase: vector.client_inputs.passphrase,
        recoveryValue: recoveryCodeToBytes(vector.client_inputs.recovery_code),
        volumeMasterKey: hexToBytes(vector.client_inputs.volume_master_key_hex),
        salt: hexToBytes(vector.submission.wrapped_artifact.kdf.salt),
        passphraseNonce: hexToBytes(vector.submission.wrapped_artifact.passphrase_wrapped.nonce),
        recoveryNonce: hexToBytes(vector.submission.wrapped_artifact.recovery_wrapped.nonce),
      });

      expect(artifact).toEqual(vector.submission.wrapped_artifact);
      const unwrappedWithPassphrase = await unwrapWithPassphrase(
        artifact,
        vector.client_inputs.passphrase,
      );
      expect(bytesToHex(unwrappedWithPassphrase)).toBe(vector.client_inputs.volume_master_key_hex);
      expect(bytesToHex(unwrapWithRecoveryCode(artifact, vector.client_inputs.recovery_code))).toBe(
        vector.client_inputs.volume_master_key_hex,
      );
    },
    PRODUCTION_KDF_TIMEOUT_MS,
  );

  it(
    'prepares a React Native artifact without relying on the browser btoa global',
    async () => {
      const host = globalThis as unknown as { btoa?: (_value: string) => string };
      const previous = host.btoa;
      delete host.btoa;
      try {
        const prepared = await prepareKeyCeremony(
          {
            protocol_version: '1.0.0',
            job_id: 'job-native',
            activation_id: 'activation-native',
            ceremony_id: 'ceremony-native',
            server_nonce: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
            expires_at: '2026-09-08T12:00:00Z',
          },
          'a native-safe private passphrase',
        );

        expect(prepared.wrappedArtifact.binding.client_nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      } finally {
        if (previous) host.btoa = previous;
      }
    },
    PRODUCTION_KDF_TIMEOUT_MS,
  );
});
