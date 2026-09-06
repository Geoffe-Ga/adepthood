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

// An address literal, deliberately. The server now refuses any destination it
// cannot establish as globally routable, and a literal is judged from the string
// alone -- `classify_user_vault_url_host` parses it, and
// `classify_resolved_user_vault_url` returns early on one rather than looking it
// up. Connecting stores the address rather than dialling it, so this proves the
// accept path over the wire without making the lane depend on DNS.
const REACHABLE_VAULT_URL = 'https://1.1.1.1';
// `.example` is an RFC 6761 reserved TLD that never resolves, and a resolver the
// lane cannot reach yields the same code by design, so this is deterministic
// with or without a network.
const UNRESOLVABLE_VAULT_URL = 'https://vault.example';
const INSECURE_VAULT_URL = 'http://vault.example';
// Loopback, judged from the string with no lookup at all.
const PRIVATE_VAULT_URL = 'https://127.0.0.1';
const VAULT_API_KEY = 'e2e-vault-credential'; // pragma: allowlist secret
// An interior space is the one thing an `Authorization` header value may not
// carry, and the trimming validator only strips the edges.
const UNUSABLE_VAULT_API_KEY = 'e2e vault credential'; // pragma: allowlist secret

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
    // The shape classifier runs first, so a plain-http address is refused for
    // its transport before anything asks where it points.
    const failure = await rejection(
      vault.connect({ vault_url: INSECURE_VAULT_URL, api_key: VAULT_API_KEY }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as ApiError).detail).toBe('vault_url_insecure_transport');
  });

  it('refuses an address that points nowhere, and says which', async () => {
    const failure = await rejection(
      vault.connect({ vault_url: UNRESOLVABLE_VAULT_URL, api_key: VAULT_API_KEY }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as ApiError).detail).toBe('vault_url_unresolvable_host');
  });

  it('refuses an address only this machine could reach', async () => {
    const failure = await rejection(
      vault.connect({ vault_url: PRIVATE_VAULT_URL, api_key: VAULT_API_KEY }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as ApiError).detail).toBe('vault_url_private_address');
  });

  it('refuses a key no Authorization header could carry, without quoting it', async () => {
    const failure = await rejection(
      vault.connect({ vault_url: REACHABLE_VAULT_URL, api_key: UNUSABLE_VAULT_API_KEY }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as ApiError).detail).toBe('vault_key_unusable');
    // The refusal is a code this endpoint owns rather than a validator's prose,
    // because prose would quote the rejected value -- and on this request the
    // rejected value is the secret.
    expect((failure as ApiError).message).not.toContain(UNUSABLE_VAULT_API_KEY);
  });

  it('leaves no row behind when any of those refusals lands', async () => {
    // A half-applied replacement would pair a new address with an old
    // credential, so the refusal has to happen before anything is written.
    const state = await vault.connection();

    expect(state.connected).toBe(false);
    expect(state.vault_url).toBeNull();
  });

  it('connects, echoes the address back, and hands back no credential', async () => {
    const state = await vault.connect({
      vault_url: REACHABLE_VAULT_URL,
      api_key: VAULT_API_KEY,
    });

    expect(state.connected).toBe(true);
    expect(state.vault_url).toBe(REACHABLE_VAULT_URL);
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
    expect(state.vault_url).toBe(REACHABLE_VAULT_URL);
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
