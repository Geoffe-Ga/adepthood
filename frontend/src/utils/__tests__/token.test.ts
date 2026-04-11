import { describe, it, expect } from '@jest/globals';

import {
  decodeJwtPayload,
  isTokenExpired,
  shouldRefreshToken,
  REFRESH_BUFFER_SECONDS,
} from '../token';

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
    const farFuture = Math.floor(Date.now() / 1000) + REFRESH_BUFFER_SECONDS + 600;
    expect(shouldRefreshToken(fakeJwt({ sub: '1', exp: farFuture, iat: 0 }))).toBe(false);
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
