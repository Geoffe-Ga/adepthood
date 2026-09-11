import { describe, it, expect } from '@jest/globals';

import {
  decodeJwtPayload,
  isTokenExpired,
  refreshDeadlineMs,
  shouldRefreshToken,
  REFRESH_BUFFER_SECONDS,
  SLIDING_RENEWAL_FRACTION,
} from '../token';

const SECONDS_PER_DAY = 24 * 60 * 60;
const THIRTY_DAYS_SECONDS = 30 * SECONDS_PER_DAY;

/** Build a fake JWT with the given payload (no real signature). */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

describe('decodeJwtPayload', () => {
  it('decodes a well-formed JWT payload', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = fakeJwt({ sub: '42', exp: now + 3600, iat: now });
    const payload = decodeJwtPayload(token);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('42');
    expect(payload!.exp).toBe(now + 3600);
    expect(payload!.iat).toBe(now);
  });

  it('returns null for a token with fewer than 3 parts', () => {
    expect(decodeJwtPayload('only-two.parts')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeJwtPayload('')).toBeNull();
  });

  it('returns null when the payload is not valid JSON', () => {
    const broken = 'header.' + btoa('not-json') + '.signature';
    expect(decodeJwtPayload(broken)).toBeNull();
  });

  it('returns null when exp is missing from the payload', () => {
    const token = fakeJwt({ sub: '1', iat: 100 });
    expect(decodeJwtPayload(token)).toBeNull();
  });
});

describe('isTokenExpired', () => {
  it('returns false for a token expiring in the future', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    expect(isTokenExpired(fakeJwt({ sub: '1', exp: futureExp, iat: 0 }))).toBe(false);
  });

  it('returns true for a token that expired in the past', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    expect(isTokenExpired(fakeJwt({ sub: '1', exp: pastExp, iat: 0 }))).toBe(true);
  });

  it('returns true for an unparseable token', () => {
    expect(isTokenExpired('garbage')).toBe(true);
  });
});

describe('shouldRefreshToken', () => {
  it('returns false when token expiry is well beyond the buffer', () => {
    const now = Math.floor(Date.now() / 1000);
    const farFuture = now + REFRESH_BUFFER_SECONDS + 600;
    expect(shouldRefreshToken(fakeJwt({ sub: '1', exp: farFuture, iat: now }))).toBe(false);
  });

  it('returns true when token is within the refresh buffer', () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + REFRESH_BUFFER_SECONDS - 10;
    expect(shouldRefreshToken(fakeJwt({ sub: '1', exp: nearExpiry, iat: 0 }))).toBe(true);
  });

  it('returns true for an already-expired token', () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    expect(shouldRefreshToken(fakeJwt({ sub: '1', exp: expired, iat: 0 }))).toBe(true);
  });

  it('returns true for an unparseable token', () => {
    expect(shouldRefreshToken('not.a.jwt')).toBe(true);
  });
});

// Sliding session (#2804): a 30-day token that only renewed in the last five
// minutes would log a daily user out on day 30 regardless of activity. Past
// the half-life mark any open app renews, so the window slides.
describe('shouldRefreshToken sliding renewal', () => {
  it('returns false before the token has consumed half its lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 14 * SECONDS_PER_DAY;
    const token = fakeJwt({ sub: '1', exp: issuedAt + THIRTY_DAYS_SECONDS, iat: issuedAt });

    expect(shouldRefreshToken(token)).toBe(false);
  });

  it('returns true once the token has consumed half its lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 16 * SECONDS_PER_DAY;
    const token = fakeJwt({ sub: '1', exp: issuedAt + THIRTY_DAYS_SECONDS, iat: issuedAt });

    expect(shouldRefreshToken(token)).toBe(true);
  });

  it('keeps the five-minute floor for a token too short for half-life to matter', () => {
    // A 5-minute token issued a minute ago is not yet at half-life, but
    // it is inside the 5-minute buffer: whichever deadline is earlier wins.
    const now = Math.floor(Date.now() / 1000);
    const token = fakeJwt({ sub: '1', exp: now + 4 * 60, iat: now - 60 });

    expect(shouldRefreshToken(token)).toBe(true);
  });

  it('falls back to the buffer rule when the token carries no iat', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = fakeJwt({ sub: '1', exp: now + THIRTY_DAYS_SECONDS });

    expect(shouldRefreshToken(token)).toBe(false);
  });
});

describe('refreshDeadlineMs', () => {
  it('lands on the half-life mark for a long-lived token', () => {
    const issuedAt = 1_700_000_000;
    const deadline = refreshDeadlineMs({
      sub: '1',
      exp: issuedAt + THIRTY_DAYS_SECONDS,
      iat: issuedAt,
    });

    expect(deadline).toBe((issuedAt + THIRTY_DAYS_SECONDS * SLIDING_RENEWAL_FRACTION) * 1000);
  });

  it('lands on the buffer mark when that comes earlier than half-life', () => {
    const issuedAt = 1_700_000_000;
    const exp = issuedAt + 6 * 60;
    const deadline = refreshDeadlineMs({ sub: '1', exp, iat: issuedAt });

    expect(deadline).toBe((exp - REFRESH_BUFFER_SECONDS) * 1000);
  });

  it('ignores an iat that is not before exp', () => {
    const exp = 1_700_000_000;
    const deadline = refreshDeadlineMs({ sub: '1', exp, iat: exp + 10 });

    expect(deadline).toBe((exp - REFRESH_BUFFER_SECONDS) * 1000);
  });
});
