import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import {
  auth,
  setTokenGetter,
  vaultActivation,
  type VaultActivation,
  type VaultKeyCeremonyChallenge,
  type VaultWrappedKeyArtifact,
} from '@/api';

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const email = `e2e-vault-activation-${randomUUID()}${EMAIL_DOMAIN}`;

function artifactFor(challenge: VaultKeyCeremonyChallenge): VaultWrappedKeyArtifact {
  return {
    version: 2,
    kdf: {
      algorithm: 'argon2id',
      salt: 'a'.repeat(32),
      time_cost: 3,
      lanes: 4,
      memory_kib: 65_536,
    },
    passphrase_wrapped: { nonce: 'b'.repeat(24), ciphertext: 'c'.repeat(96) },
    recovery_wrapped: { nonce: 'd'.repeat(24), ciphertext: 'e'.repeat(96) },
    binding: {
      protocol_version: '1.0.0',
      activation_id: challenge.activation_id,
      ceremony_id: challenge.ceremony_id,
      server_nonce: challenge.server_nonce,
      client_nonce: 'F'.repeat(43),
    },
  };
}

async function expectReady(): Promise<VaultActivation> {
  const status = await vaultActivation.status();
  expect(status.state).toBe('ready');
  return status;
}

describe('private-vault activation against a fake Creek control plane', () => {
  let sessionToken: string | null = null;

  afterAll(() => setTokenGetter(null));

  it('creates its own authenticated account', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
    expect(response.user_id).toBeGreaterThan(0);
  });

  it('reads inactive progress without allocating anything', async () => {
    await expect(vaultActivation.status()).resolves.toEqual({
      active: false,
      state: 'inactive',
      retryable: false,
      failure_reason: null,
      credential_received: false,
      attested_confidential: null,
    });
  });

  it('activates explicitly and resumes at the client-held ceremony', async () => {
    const started = await vaultActivation.activate();
    expect(started.state).toBe('pending');
    expect(started.active).toBe(true);

    const resumed = await vaultActivation.status();
    expect(resumed.state).toBe('awaiting_key_ceremony');
    expect(resumed.credential_received).toBe(false);
  });

  it('relays a public challenge and only a wrapped completion', async () => {
    const challenge = await vaultActivation.keyCeremony();
    expect(challenge.protocol_version).toBe('1.0.0');

    const completion = await vaultActivation.completeCeremony({
      protocol_version: '1.0.0',
      ceremony_id: challenge.ceremony_id,
      server_nonce: challenge.server_nonce,
      recovery_saved: true,
      wrapped_artifact: artifactFor(challenge),
      attestation: null,
      key_release: null,
    });
    expect(['awaiting_handoff', 'ready']).toContain(completion.state);
    expect(Object.keys(completion)).not.toContain('passphrase');
    expect(Object.keys(completion)).not.toContain('recovery_key');
  });

  it('finishes from the durable handoff and reports the real verified capability', async () => {
    const ready = await expectReady();

    expect(ready.credential_received).toBe(true);
    expect(ready.attested_confidential).toBe(false);
  });
});
