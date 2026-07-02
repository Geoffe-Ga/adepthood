/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import {
  habits,
  auth,
  setTokenGetter,
  setOnUnauthorized,
  setOnTokenRefreshed,
  ApiError,
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

/**
 * JWT-shaped fixture token (BUG-API-017): three base64url segments
 * separated by dots.  The schema validator now rejects anything that
 * does not match this shape, so test fixtures must use it too.
 */
function fixtureJwt(label = 'refreshed'): string {
  // Base64url alphabet only; padding with the label keeps tests
  // self-describing in failure output without adding any decode logic.
  const seg = (s: string) => `${'a'.repeat(8)}${s}`;
  return `${seg('h')}.${seg(label)}.${seg('s')}`;
}

let capturedToken: string | null = null;
const mockOnUnauthorized = jest.fn();
const mockOnTokenRefreshed = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockOnUnauthorized.mockReset();
  mockOnTokenRefreshed.mockReset();
  capturedToken = 'original-token';
  setTokenGetter(() => capturedToken);
  setOnUnauthorized(mockOnUnauthorized);
  setOnTokenRefreshed(mockOnTokenRefreshed);
});

describe('auth.refresh', () => {
  test('sends POST to /auth/refresh with token in header', async () => {
    const newJwt = fixtureJwt('newjwt');
    mockFetch.mockReturnValueOnce(jsonResponse({ token: newJwt, user_id: 1 }));

    const result = await auth.refresh('my-token');

    expect(result.token).toBe(newJwt);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer my-token' });
  });
});

describe('retry-after-refresh on 401', () => {
  test('retries a failed request after refreshing the token', async () => {
    // ``user_id`` is intentionally absent — see ``habitSchema`` in ``schemas.ts``.
    const sampleHabit = {
      id: 1,
      name: 'Habit',
      icon: '✨',
      start_date: '2024-01-01',
      energy_cost: 1,
      energy_return: 2,
      milestone_notifications: false,
      stage: 'Beige',
      streak: 0,
      goals: [],
    };

    const refreshedToken = fixtureJwt('refreshedtoken');
    // First call: 401 from /habits
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    // Second call: refresh succeeds
    mockFetch.mockReturnValueOnce(jsonResponse({ token: refreshedToken, user_id: 1 }));
    // Third call: retry /habits with new token succeeds
    mockFetch.mockReturnValueOnce(jsonResponse([sampleHabit]));

    const result = await habits.list();

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify the refresh call
    const [refreshUrl, refreshInit] = mockFetch.mock.calls[1];
    expect(refreshUrl).toBe('http://test/auth/refresh');
    expect(refreshInit.headers).toMatchObject({ Authorization: 'Bearer original-token' });

    // Verify the retry uses the new token
    const [, retryInit] = mockFetch.mock.calls[2];
    expect(retryInit.headers).toMatchObject({ Authorization: `Bearer ${refreshedToken}` });

    // The onTokenRefreshed callback receives the new token plus the
    // server's stored timezone so the AuthContext can keep
    // ``userTimezone`` in sync.  ``undefined`` is the value when the
    // server omits the field (legacy / mocked responses).
    expect(mockOnTokenRefreshed).toHaveBeenCalledWith(refreshedToken, undefined, 'original-token');

    expect(result).toEqual([sampleHabit]);
  });

  test('calls onUnauthorized when refresh fails', async () => {
    // First call: 401 from /habits
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    // Second call: refresh also fails
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list()).rejects.toThrow(ApiError);

    expect(mockOnUnauthorized).toHaveBeenCalled();
  });

  test('calls onUnauthorized when retry also returns 401', async () => {
    // First call: 401
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    // Refresh succeeds
    mockFetch.mockReturnValueOnce(jsonResponse({ token: fixtureJwt('newtok'), user_id: 1 }));
    // Retry also returns 401
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list()).rejects.toThrow(ApiError);

    expect(mockOnUnauthorized).toHaveBeenCalled();
  });

  test('does not retry for auth endpoints (avoids infinite loops)', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'invalid_credentials' }, 401));

    const credentials = { email: 'test@test.com', password: 'wrong' }; // pragma: allowlist secret
    await expect(auth.login(credentials)).rejects.toThrow(ApiError);

    // Only the original call — no refresh attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry when a manual token override is provided', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list('manual-token')).rejects.toThrow(ApiError);

    // Only the original call — no refresh attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('in-flight dedupe + timeout (audit-contracts-05)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('coalesces concurrent 401s into a single network refresh', async () => {
    const newJwt = fixtureJwt('shared');
    let refreshCalls = 0;
    let refreshed = false;
    // Branch on URL so both concurrent /habits requests 401 before either
    // refresh completes, then succeed once the shared refresh has run.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        refreshed = true;
        return jsonResponse({ token: newJwt, user_id: 1 });
      }
      return refreshed ? jsonResponse([]) : jsonResponse({ detail: 'unauthorized' }, 401);
    });

    const [first, second] = await Promise.all([habits.list(), habits.list()]);

    // Two concurrent 401s, but exactly one refresh hit the network.
    expect(refreshCalls).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    // The in-flight promise cleared on settle: a later refresh still fires.
    refreshed = false;
    refreshCalls = 0;
    await habits.list();
    expect(refreshCalls).toBe(1);
  });

  test('a refresh that times out resolves gracefully (onUnauthorized, no throw)', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        // Never resolves on its own; rejects when fetchWithTimeout's clock wins.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return jsonResponse({ detail: 'unauthorized' }, 401);
    });

    const promise = habits.list();
    promise.catch(() => {});
    await jest.runAllTimersAsync();

    // The timed-out refresh becomes a refresh failure (no uncaught throw): the
    // original 401 surfaces as ApiError and the unauthorized handler fires.
    await expect(promise).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).toHaveBeenCalled();
  });
});
