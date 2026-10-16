import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { refreshSessionToken, resetTokenRotations, setTokenGetter } from '../index';
import {
  captureAuthScope,
  getAuthSession,
  hasOnlySessionEnded,
  isAuthScopeCurrent,
} from '../sessionToken';

import { beginActiveUserTransition, setActiveUser } from '@/storage/userScope';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
const fetchMock = jest.fn<typeof fetch>();
const previousFetch = globalThis.fetch;
const base64Url = (json: object): string =>
  btoa(JSON.stringify(json)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
const tokenFor = (owner: number, version: number) =>
  `e30.${base64Url({ sub: String(owner), exp: 4_000_000_000, jti: String(version) })}.sig`;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  setTokenGetter(null);
  resetTokenRotations();
});

it('moves the auth session at every session boundary (#3326)', () => {
  const before = getAuthSession();
  resetTokenRotations();
  expect(getAuthSession()).toBe(before + 1);
  resetTokenRotations();
  expect(getAuthSession()).toBe(before + 2);
});

it('keeps the auth session across a legitimate token refresh', async () => {
  let live = tokenFor(1, 1);
  setTokenGetter(() => live);
  const renewed = tokenFor(1, 2);
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ token: renewed, user_id: 1 }),
  } as Response);
  const before = getAuthSession();

  const response = await refreshSessionToken(live);
  live = response.token;

  expect(live).toBe(renewed);
  expect(getAuthSession()).toBe(before);
});

describe('the shared auth scope (#3423)', () => {
  afterEach(() => {
    setActiveUser(null);
  });

  it('holds until a session boundary, and then only the session has ended', () => {
    setActiveUser(1);
    const scope = captureAuthScope();
    expect(isAuthScopeCurrent(scope)).toBe(true);
    expect(hasOnlySessionEnded(scope)).toBe(false);

    resetTokenRotations();

    expect(isAuthScopeCurrent(scope)).toBe(false);
    expect(hasOnlySessionEnded(scope)).toBe(true);
  });

  it('treats a change of account as more than a session ending', () => {
    setActiveUser(1);
    const scope = captureAuthScope();
    resetTokenRotations();
    setActiveUser(2);

    expect(isAuthScopeCurrent(scope)).toBe(false);
    expect(hasOnlySessionEnded(scope)).toBe(false);
  });

  it('is current for nothing while an account cleanup runs', () => {
    setActiveUser(1);
    beginActiveUserTransition();
    const scope = captureAuthScope();

    expect(isAuthScopeCurrent(scope)).toBe(false);
    expect(hasOnlySessionEnded(scope)).toBe(false);
  });
});
