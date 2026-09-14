import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, setTokenGetter, vaultActivation, type VaultActivation } from '@/api';

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const email = `e2e-vault-activation-${randomUUID()}${EMAIL_DOMAIN}`;

async function expectReady(): Promise<VaultActivation> {
  const status = await vaultActivation.status();
  expect(status.state).toBe('ready');
  return status;
}

describe('provider-managed activation against a fake Creek v2 control plane', () => {
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
      new_activation_available: true,
      retryable: false,
      failure_reason: null,
      credential_received: false,
      attested_confidential: null,
      custody_mode: null,
    });
  });

  it('progresses directly through pending and provisioning without a ceremony', async () => {
    const started = await vaultActivation.activate();
    expect(started).toMatchObject({
      active: true,
      state: 'pending',
      credential_received: false,
      custody_mode: null,
    });

    const provisioning = await vaultActivation.status();
    expect(provisioning).toMatchObject({
      state: 'provisioning',
      credential_received: false,
      custody_mode: null,
    });
  });

  it('accepts the authenticated handoff and reports explicit custody at ready', async () => {
    const ready = await expectReady();

    expect(ready).toMatchObject({
      credential_received: true,
      attested_confidential: false,
      custody_mode: 'provider_managed',
    });
    expect(Object.keys(ready)).not.toContain('passphrase');
    expect(Object.keys(ready)).not.toContain('recovery_key');
    expect(Object.keys(vaultActivation)).toEqual(['status', 'activate', 'retry']);
  });
});
