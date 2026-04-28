/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
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
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'new-jwt', user_id: 1 }));

    const result = await auth.refresh('my-token');

    expect(result.token).toBe('new-jwt');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer my-token' });
  });
});

describe('retry-after-refresh on 401', () => {
  test('retries a failed request after refreshing the token', async () => {
    // Full-fidelity habit so the BUG-024 Zod validator accepts the response.
    const sampleHabit = {
      id: 1,
      user_id: 1,
      name: 'Habit',
      icon: '✨',
      start_date: '2024-01-01T00:00:00Z',
      energy_cost: 1,
      energy_return: 2,
      milestone_notifications: false,
      stage: 'Beige',
      streak: 0,
      goals: [],
    };

    // First call: 401 from /habits
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    // Second call: refresh succeeds
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'refreshed-token', user_id: 1 }));
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
    expect(retryInit.headers).toMatchObject({ Authorization: 'Bearer refreshed-token' });

    // The onTokenRefreshed callback receives the new token plus the
    // server's stored timezone so the AuthContext can keep
    // ``userTimezone`` in sync.  ``undefined`` is the value when the
    // server omits the field (legacy / mocked responses).
    expect(mockOnTokenRefreshed).toHaveBeenCalledWith('refreshed-token', undefined);

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
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'new-token', user_id: 1 }));
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
