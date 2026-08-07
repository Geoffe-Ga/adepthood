import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, journal, setTokenGetter } from '@/api';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const JWT_SEGMENTS = 3;
const HTTP_UNAUTHORIZED = 401;

const email = `e2e-auth-${randomUUID()}${EMAIL_DOMAIN}`;

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
});
