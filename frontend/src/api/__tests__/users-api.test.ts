/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { users, setTokenGetter, ApiError, ApiValidationError } from '../index';

// Mock global fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

// Silence the API_BASE_URL import — just needs a string value
jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

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

describe('users API client', () => {
  test('users.updateMyTimezone sends PUT with the IANA name and auth header', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ timezone: 'America/Los_Angeles' }));

    const result = await users.updateMyTimezone({ timezone: 'America/Los_Angeles' }, 'test-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/users/me/timezone');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ timezone: 'America/Los_Angeles' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual({ timezone: 'America/Los_Angeles' });
  });

  test('users.updateMyTimezone authenticates via the global token getter when no token is passed', async () => {
    // The production path: TimezoneSettingsScreen calls without an explicit
    // token and relies on the AuthContext-installed getter.
    setTokenGetter(() => 'getter-token');
    try {
      mockFetch.mockReturnValueOnce(jsonResponse({ timezone: 'America/Los_Angeles' }));

      await users.updateMyTimezone({ timezone: 'America/Los_Angeles' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers).toMatchObject({ Authorization: 'Bearer getter-token' });
    } finally {
      setTokenGetter(null);
    }
  });

  test('users.updateMyTimezone surfaces a 422 as ApiError with the server status', async () => {
    expect.assertions(2);
    mockFetch.mockReturnValueOnce(
      jsonResponse({ detail: "unknown IANA timezone: 'Mars/Phobos'" }, 422),
    );

    try {
      await users.updateMyTimezone({ timezone: 'Mars/Phobos' }, 'test-token');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
    }
  });

  test('users.updateMyTimezone rejects a malformed success body at the boundary', async () => {
    // BUG-024 runtime validation: a response without ``timezone`` must not
    // reach the AuthContext, where it would corrupt ``userTimezone``.
    mockFetch.mockReturnValueOnce(jsonResponse({ unexpected: true }));

    await expect(
      users.updateMyTimezone({ timezone: 'America/Los_Angeles' }, 'test-token'),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });
});
