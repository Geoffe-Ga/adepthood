/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
/**
 * BUG-API-018 — the API client must distinguish three flavours of 401:
 *
 *  - ``not_authenticated`` (anonymous request hit a protected endpoint),
 *  - ``session_expired``   (had a session token, refresh failed), and
 *  - ``invalid_token``     (server explicitly says the token is forged).
 *
 * Previously every 401 collapsed into a single "session expired" path,
 * so an anonymous caller saw the misleading "Your session has expired"
 * banner before they had ever signed in.  These tests pin the new
 * structured reason on each branch.
 */
import {
  auth,
  classifyUnauthorizedDetail,
  habits,
  setOnUnauthorized,
  setTokenGetter,
} from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const onUnauthorized = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  onUnauthorized.mockReset();
  setOnUnauthorized(onUnauthorized);
});

describe('classifyUnauthorizedDetail', () => {
  test('"unauthorized" maps to session_expired', () => {
    expect(classifyUnauthorizedDetail('unauthorized')).toBe('session_expired');
  });

  test('"invalid_token" maps to invalid_token', () => {
    expect(classifyUnauthorizedDetail('invalid_token')).toBe('invalid_token');
  });

  test('"invalid_credentials" returns null so the login form keeps ownership', () => {
    expect(classifyUnauthorizedDetail('invalid_credentials')).toBeNull();
  });

  test('unknown details return null (caller picks the default)', () => {
    expect(classifyUnauthorizedDetail('mystery')).toBeNull();
    expect(classifyUnauthorizedDetail(null)).toBeNull();
  });
});

describe('401 with no token attached', () => {
  test('fires onUnauthorized with reason="not_authenticated"', async () => {
    setTokenGetter(() => null);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list()).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledWith('not_authenticated');
  });
});

describe('401 with a stored session token', () => {
  test('fires onUnauthorized with reason="session_expired" when refresh fails', async () => {
    setTokenGetter(() => 'stored-token');
    // First call: original request 401s.
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    // Refresh attempt also 401s -> session is genuinely expired.
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list()).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledWith('session_expired');
  });

  test('fires onUnauthorized with reason="invalid_token" when the server rejects the token outright', async () => {
    setTokenGetter(() => 'stored-token');
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_token' }, 401));
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_token' }, 401));

    await expect(habits.list()).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledWith('invalid_token');
  });
});

describe('401 with detail="invalid_credentials"', () => {
  test('does NOT fire the global unauthorized callback', async () => {
    // /auth/login is the only endpoint expected to return this code, but a
    // non-auth 401 with this detail is still treated as "the login form
    // owns this error" -- never as a session expiration.
    setTokenGetter(() => 'stored-token');
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_credentials' }, 401));

    await expect(habits.list()).rejects.toThrow();

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('401 on /auth/* paths', () => {
  test('login 401 does not trigger onUnauthorized', async () => {
    // Auth endpoints own their own UI for credential failures; the
    // global "session expired" handler must not fire.
    setTokenGetter(() => null);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_credentials' }, 401));

    await expect(
      auth.login({ email: 'a@b.test', password: 'wrong' }), // pragma: allowlist secret
    ).rejects.toThrow();

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
