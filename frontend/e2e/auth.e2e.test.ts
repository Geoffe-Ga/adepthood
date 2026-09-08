import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, journal, setTokenGetter, users } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const JWT_SEGMENTS = 3;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

const email = `e2e-auth-${randomUUID()}${EMAIL_DOMAIN}`;
// Two would-be second holders of the same key: one refused while the first
// account lives, one admitted once it has been deleted (ADR 0008 D2 / D3).
const rivalEmail = `e2e-auth-rival-${randomUUID()}${EMAIL_DOMAIN}`;
const heirEmail = `e2e-auth-heir-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('auth journey against a live server', () => {
  let sessionToken: string | null = null;
  let signupUserId = 0;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('signs up a fresh account and returns a usable session', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.token.split('.')).toHaveLength(JWT_SEGMENTS);
    expect(response.user_id).toBeGreaterThan(0);
    expect(response.timezone).toBe(TIMEZONE);

    signupUserId = response.user_id;
  });

  it('logs the same account back in and hands the token to the client', async () => {
    const response = await auth.login({ email, password: PASSWORD });

    expect(response.user_id).toBe(signupUserId);
    expect(response.token.split('.')).toHaveLength(JWT_SEGMENTS);
    expect(response.timezone).toBe(TIMEZONE);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('reads the new account state through the authenticated client', async () => {
    const page = await journal.list();

    // A brand-new account owns nothing: exact envelope, no bare status check.
    expect(page).toEqual({ items: [], total: 0, has_more: false });
  });

  it('rejects the same call with a 401 once the token getter yields null', async () => {
    setTokenGetter(() => null);

    const failure = await rejection(journal.list());

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
  });

  it('rejects a wrong password with the backend invalid_credentials detail', async () => {
    const wrong = 'not-the-password'; // pragma: allowlist secret
    const failure = await rejection(auth.login({ email, password: wrong }));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
    expect((failure as ApiError).detail).toBe('invalid_credentials');
  });

  it('refuses a second account presenting an already-redeemed key with invalid_license', async () => {
    // The launcher's stub keys the sale on the licence key, so this is a second
    // claim on the sale the first account holds. The refusal is the generic one:
    // nothing on the wire says the key was valid but taken.
    const failure = await rejection(
      auth.signup({
        email: rivalEmail,
        password: PASSWORD,
        timezone: TIMEZONE,
        license_key: LICENSE_KEY,
      }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as ApiError).detail).toBe('invalid_license');
    // The first account is untouched by the refused claim.
    expect((await auth.login({ email, password: PASSWORD })).user_id).toBe(signupUserId);
  });

  it('releases the key when the first account is deleted and lets one new account redeem it', async () => {
    setTokenGetter(() => sessionToken);
    const receipt = await users.deleteMyAccount({ confirm_email: email });
    expect(receipt.erased).toContain('licensebinding');

    const heir = await auth.signup({
      email: heirEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(heir.user_id).toBeGreaterThan(0);
    expect(heir.user_id).not.toBe(signupUserId);
    // Access alone transferred: the heir starts with nothing of the old account's.
    sessionToken = heir.token;
    expect(await journal.list()).toEqual({ items: [], total: 0, has_more: false });
    // ...and the key is spent again: a third account is refused exactly as before.
    const failure = await rejection(
      auth.signup({
        email: rivalEmail,
        password: PASSWORD,
        timezone: TIMEZONE,
        license_key: LICENSE_KEY,
      }),
    );
    expect((failure as ApiError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as ApiError).detail).toBe('invalid_license');
  });
});
