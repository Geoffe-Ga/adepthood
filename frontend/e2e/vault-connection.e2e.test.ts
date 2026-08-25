import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, setTokenGetter, vault } from '@/api';

/**
 * Connecting a vault of your own, proven across the wire.
 *
 * Both halves are green on their own and neither one sees the other: the
 * screen's tests mock the client, and the router's tests never build a request.
 * A screen wired to a path the server does not serve, or reading a field it does
 * not send, passes both suites and connects nobody. This is the one place the
 * two agree on the paths, the verbs, the refusal code, and the fact that the
 * credential comes back on nothing.
 *
 * What it does not test is replication: sending a copy of an entry needs a real
 * Creek Vault to send it to, and this lane has none. Connecting is upstream of
 * that and is the part a person touches.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_UNPROCESSABLE = 422;

const SECURE_VAULT_URL = 'https://vault.example';
const INSECURE_VAULT_URL = 'http://vault.example';
const VAULT_API_KEY = 'e2e-vault-credential'; // pragma: allowlist secret

const email = `e2e-vault-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-vault-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('vault-connection journey against a live server', () => {
  let sessionToken: string | null = null;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('answers a fresh account plainly rather than with a 404', async () => {
    // "You have no vault" is an answer about a resource every account has in
    // the abstract, so the screen can render the offer without first handling
    // an error.
    const state = await vault.connection();

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  it('refuses an address it cannot reach securely, with the code the screen maps', async () => {
    const failure = await rejection(
      vault.connect({ vault_url: INSECURE_VAULT_URL, api_key: VAULT_API_KEY }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as ApiError).detail).toBe('vault_url_insecure_transport');
  });

  it('leaves no row behind when it refuses', async () => {
    // A half-applied replacement would pair a new address with an old
    // credential, so the refusal has to happen before anything is written.
    const state = await vault.connection();

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  it('connects, echoes the address back, and hands back no credential', async () => {
    const state = await vault.connect({
      vault_url: SECURE_VAULT_URL,
      api_key: VAULT_API_KEY,
    });

    expect(state.connected).toBe(true);
    expect(state.vault_url).toBe(SECURE_VAULT_URL);
    // Write-only by construction: no response schema on this seam has a field
    // to put a credential in, and this is the assertion that says so on the
    // wire rather than in a docstring.
    expect(Object.keys(state)).not.toContain('api_key');
  });

  it('reads the same connection back on a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    const state = await vault.connection();

    expect(state.connected).toBe(true);
    expect(state.vault_url).toBe(SECURE_VAULT_URL);
  });

  it("keeps one account's vault off another account", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads the subject from the JWT alone, so the neighbour sees
    // their own empty answer rather than anything the first account connected.
    const state = await vault.connection();

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  it('disconnects the account that connected, and says so on the next read', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    await vault.disconnect();
    const state = await vault.connection();

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  it('treats a second disconnect as the state already asked for', async () => {
    // Idempotent, and 204 either way: reporting a 404 here would describe the
    // plumbing rather than the outcome.
    await expect(vault.disconnect()).resolves.toBeUndefined();

    expect((await vault.connection()).connected).toBe(false);
  });
});
