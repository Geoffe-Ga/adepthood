import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, depthPreferences, setTokenGetter } from '@/api';
import type { DepthPreferences } from '@/api';

/**
 * "You choose your depth", proven across the wire.
 *
 * Three of the five primary destinations are ring-gated, so if the toggles the
 * Choose-Depths section writes never reach `userdepthpreferences` -- or reach
 * it under different field names -- most of the app quietly disappears for the
 * user, or quietly refuses to. Both suites stay green through that: the store's
 * unit tests mock the client, and the router's tests never see the client at
 * all. This is the one place the two halves have to agree on the four field
 * names, the PATCH verb, and the trailing-slash-free path.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_UNPROCESSABLE = 422;

/** What a fresh account is provisioned with: nothing declined yet. */
const ALL_RINGS_ON: DepthPreferences = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

/** The state the account chooses: two rings quieted, two left open. */
const CHOSEN = { ...ALL_RINGS_ON, enable_habits: false, enable_sangha: false };

/** The state after the Sangha ring is invited back in on its own. */
const SANGHA_BACK = { ...CHOSEN, enable_sangha: true };

const email = `e2e-depth-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-depth-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('depth-ring journey against a live server', () => {
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

  it('offers every ring on the first read, so nothing is opted out for the user', async () => {
    const preferences = await depthPreferences.get();

    expect(preferences).toEqual(ALL_RINGS_ON);
  });

  it('quiets two rings in the single PATCH the section sends', async () => {
    // The section sends only what moved. The server echoes all four keys back,
    // so a partial write that clobbered the untouched rings shows up here.
    const updated = await depthPreferences.update({
      enable_habits: false,
      enable_sangha: false,
    });

    expect(updated).toEqual(CHOSEN);
  });

  it('hands the same choice to a cold start on a freshly-minted session', async () => {
    // Logging in again is what "the app they come back to" means: a new JWT, a
    // new client session, and a read that has to come from the row rather than
    // from anything the process was still holding.
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    const preferences = await depthPreferences.get();

    expect(preferences).toEqual(CHOSEN);
  });

  it('invites one ring back without disturbing the other declined depth', async () => {
    const updated = await depthPreferences.update({ enable_sangha: true });

    expect(updated).toEqual(SANGHA_BACK);
    expect(await depthPreferences.get()).toEqual(SANGHA_BACK);
  });

  it('refuses a PATCH that asserts nothing rather than writing a no-op', async () => {
    const failure = await rejection(depthPreferences.update({}));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNPROCESSABLE);
    // The declined rings are still declined: a rejected request touched nothing.
    expect(await depthPreferences.get()).toEqual(SANGHA_BACK);
  });

  it("keeps one account's declined rings off another account", async () => {
    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The route reads the subject from the JWT alone, so the neighbour must see
    // its own untouched provisioning, not the choice the first account made.
    expect(await depthPreferences.get()).toEqual(ALL_RINGS_ON);

    const back = await auth.login({ email, password: PASSWORD });
    sessionToken = back.token;
    expect(await depthPreferences.get()).toEqual(SANGHA_BACK);
  });
});
