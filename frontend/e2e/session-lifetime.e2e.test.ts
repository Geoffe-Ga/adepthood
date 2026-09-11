import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, journal, setTokenGetter } from '@/api';
import { decodeJwtPayload } from '@/utils/token';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const HTTP_UNAUTHORIZED = 401;

// The sliding-session ceiling (#2804). ``exp`` is floored to a whole second
// while ``iat`` keeps its fraction, so the measured lifetime lands within one
// second below the constant.
const SECONDS_PER_DAY = 24 * 60 * 60;
const SESSION_LIFETIME_SECONDS = 30 * SECONDS_PER_DAY;
const EXP_FLOOR_TOLERANCE_SECONDS = 1;

const email = `e2e-session-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/** ``exp - iat`` of a minted token, in seconds. */
function lifetimeSeconds(token: string): number {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.iat !== 'number') {
    throw new Error('expected the server to mint a token carrying exp and iat');
  }
  return payload.exp - payload.iat;
}

describe('session lifetime journey against a live server', () => {
  let firstToken = '';
  let rotatedToken = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('logs in and is handed a token that lives thirty days', async () => {
    await auth.signup({ email, password: PASSWORD, timezone: TIMEZONE, license_key: LICENSE_KEY });
    const response = await auth.login({ email, password: PASSWORD });

    firstToken = response.token;
    const lifetime = lifetimeSeconds(firstToken);
    expect(lifetime).toBeGreaterThanOrEqual(SESSION_LIFETIME_SECONDS - EXP_FLOOR_TOLERANCE_SECONDS);
    expect(lifetime).toBeLessThanOrEqual(SESSION_LIFETIME_SECONDS);
  });

  it('rotates the session on refresh and the new token reads the account', async () => {
    const response = await auth.refresh(firstToken);

    rotatedToken = response.token;
    expect(rotatedToken).not.toBe(firstToken);
    expect(lifetimeSeconds(rotatedToken)).toBeGreaterThanOrEqual(
      SESSION_LIFETIME_SECONDS - EXP_FLOOR_TOLERANCE_SECONDS,
    );

    setTokenGetter(() => rotatedToken);
    expect(await journal.list()).toEqual({ items: [], total: 0, has_more: false });
  });

  it('refuses the token that was rotated away, whatever its exp still says', async () => {
    // The old token is nowhere near expiry; the refusal is the revocation
    // row `/auth/refresh` wrote, crossing from the client's rotation to the
    // server's `revokedtoken` lookup on the next authenticated call.
    setTokenGetter(() => firstToken);

    const failure = await rejection(journal.list());

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
  });
});
