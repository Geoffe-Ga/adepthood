/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { auth, setOnUnauthorized, ApiError, ApiValidationError } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const ENDPOINT = 'http://test/auth/oauth/google';
const ID_TOKEN = 'google-header.google-payload.google-signature';
const SESSION_JWT = 'session.jwt.signature';
const TIMEZONE = 'America/Chicago';
const LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

describe('auth.oauthGoogle', () => {
  test('POSTs the id token and timezone to /auth/oauth/google', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: SESSION_JWT, user_id: 12 }));

    await auth.oauthGoogle({ id_token: ID_TOKEN, timezone: TIMEZONE });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ id_token: ID_TOKEN, timezone: TIMEZONE });
  });

  test('forwards the license key on the retry leg', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: SESSION_JWT, user_id: 12 }));

    await auth.oauthGoogle({ id_token: ID_TOKEN, license_key: LICENSE_KEY, timezone: TIMEZONE });

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      id_token: ID_TOKEN,
      license_key: LICENSE_KEY,
      timezone: TIMEZONE,
    });
  });

  test('resolves the parsed AuthResponse on 200', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ token: SESSION_JWT, user_id: 12, timezone: TIMEZONE }),
    );

    const result = await auth.oauthGoogle({ id_token: ID_TOKEN });

    expect(result).toEqual({ token: SESSION_JWT, user_id: 12, timezone: TIMEZONE });
  });

  test('sends no Authorization header — the exchange is the anonymous entry point', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: SESSION_JWT, user_id: 12 }));

    await auth.oauthGoogle({ id_token: ID_TOKEN });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  // ``user_id === 0`` is the /auth/signup anti-enumeration sentinel and has no
  // meaning here; accepting it would persist a zombie session.
  test('rejects a response carrying the user_id=0 sentinel', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: SESSION_JWT, user_id: 0 }));

    await expect(auth.oauthGoogle({ id_token: ID_TOKEN })).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });

  test('rejects a response whose token is not a structural JWT', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'not-a-jwt', user_id: 12 }));

    await expect(auth.oauthGoogle({ id_token: ID_TOKEN })).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });

  test('surfaces the 409 needs_license refusal as a typed ApiError', async () => {
    expect.assertions(3);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'needs_license' }, 409));

    try {
      await auth.oauthGoogle({ id_token: ID_TOKEN });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).detail).toBe('needs_license');
    }
  });

  test('surfaces the 401 invalid_oauth_token refusal as a typed ApiError', async () => {
    expect.assertions(2);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_oauth_token' }, 401));

    try {
      await auth.oauthGoogle({ id_token: ID_TOKEN });
    } catch (err) {
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).detail).toBe('invalid_oauth_token');
    }
  });

  // The caller was never signed in, so a 401 here must not fire the global
  // "session expired" re-auth sheet on top of the screen's own error.
  test('does not trigger the global unauthorized handler on a 401', async () => {
    const onUnauthorized = jest.fn();
    setOnUnauthorized(onUnauthorized);
    try {
      mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_oauth_token' }, 401));

      await expect(auth.oauthGoogle({ id_token: ID_TOKEN })).rejects.toBeInstanceOf(ApiError);

      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      setOnUnauthorized(null);
    }
  });
});
