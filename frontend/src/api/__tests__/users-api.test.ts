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

const DELETION_RECEIPT = {
  recoverable: false,
  rows_erased: 12,
  erased: ['habit', 'journalentry'],
  anonymised: ['practice'],
  retained: ['coursestage'],
  vault: { configured: false, purged: false, guidance: 'No Creek Vault was connected.' },
};

describe('users.deleteMyAccount', () => {
  test('sends DELETE /users/me with the typed confirmation in the body', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(DELETION_RECEIPT));

    const result = await users.deleteMyAccount({ confirm_email: 'w@example.com' }, 'test-token');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/users/me');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ confirm_email: 'w@example.com' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(result).toEqual(DELETION_RECEIPT);
  });

  test('never retries — an irreversible erasure must be attempted exactly once', async () => {
    // 503 is in the transient set the client retries for safe methods. If
    // DELETE ever joined them, a network hiccup could fire a second erasure.
    mockFetch.mockReturnValue(jsonResponse({ detail: 'service_unavailable' }, 503));

    await expect(
      users.deleteMyAccount({ confirm_email: 'w@example.com' }, 'test-token'),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('rejects a malformed receipt at the boundary', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ recoverable: false }));

    await expect(
      users.deleteMyAccount({ confirm_email: 'w@example.com' }, 'test-token'),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });
});
