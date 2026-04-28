/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */

/**
 * Coverage for the BUG-FRONTEND-INFRA-001, 007, 024, 010 fixes:
 *
 *  - Fetch timeout with AbortController (001)
 *  - Exponential-backoff retry for transient statuses + idempotent methods (007)
 *  - Zod runtime validation at the API boundary with ``ApiValidationError`` (024)
 *  - ``tier`` narrowed with a runtime guard rather than a blind cast (010)
 */
import {
  ApiError,
  ApiTimeoutError,
  ApiValidationError,
  auth,
  energy,
  FETCH_TIMEOUT_MS,
  habits,
  practiceSessions,
  setOnUnauthorized,
  setTokenGetter,
  toLocalHabit,
  type ApiHabitWithGoals,
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

function validHabit(overrides: Partial<ApiHabitWithGoals> = {}): ApiHabitWithGoals {
  return {
    id: 1,
    user_id: 7,
    name: 'Meditate',
    icon: '🧘',
    start_date: '2024-01-01T00:00:00Z',
    energy_cost: 1,
    energy_return: 2,
    milestone_notifications: false,
    stage: 'Beige',
    streak: 3,
    goals: [],
    ...overrides,
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  mockFetch.mockReset();
  setTokenGetter(null);
  setOnUnauthorized(null);
  // Silence the BUG-024 "[api] response validation failed" line — it's meant
  // to flag production regressions, not test assertions.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  warnSpy.mockRestore();
});

describe('BUG-024: Zod validation at the API boundary', () => {
  test('auth.login throws ApiValidationError when token is missing', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ user_id: 1 })); // no token!

    await expect(
      auth.login({ email: 'u@test.com', password: 'p' }), // pragma: allowlist secret
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('auth.signup accepts user_id=0 (duplicate-email sentinel, BUG-AUTH-002)', async () => {
    // The backend returns ``user_id: 0`` together with a dummy JWT when the
    // email is already registered, so the response is indistinguishable in
    // shape from a fresh signup and account enumeration is blocked. The
    // frontend must accept this sentinel, not reject it as a validation
    // failure.
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'dummy', user_id: 0 }));
    const result = await auth.signup({
      email: 'u@test.com',
      password: 'securepass123', // pragma: allowlist secret
    });
    expect(result.user_id).toBe(0);
    expect(result.token).toBe('dummy');
  });

  test('auth.signup still rejects negative user_id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'x', user_id: -1 }));
    await expect(
      auth.signup({
        email: 'u@test.com',
        password: 'securepass123', // pragma: allowlist secret
      }),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('habits.list accepts a schema-valid list and returns it unchanged', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([validHabit()]));
    const result = await habits.list();
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Meditate');
  });

  test('habits.list raises ApiValidationError when a field is the wrong type', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse([validHabit({ streak: 'three' as unknown as number })]),
    );
    await expect(habits.list()).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('BUG-010: tier narrowing via runtime guard', () => {
  test('toLocalHabit keeps known tier values', () => {
    const local = toLocalHabit(validHabit({ goals: [sampleGoal({ tier: 'stretch' })] }));
    expect(local.goals[0]!.tier).toBe('stretch');
  });

  test('toLocalHabit maps unknown tier strings to the safe default', () => {
    const local = toLocalHabit(validHabit({ goals: [sampleGoal({ tier: 'unknown_tier' })] }));
    expect(local.goals[0]!.tier).toBe('clear');
  });

  test('toLocalHabit ignores invalid notification_frequency rather than coercing it', () => {
    const local = toLocalHabit(validHabit({ notification_frequency: 'sometimes' as never }));
    expect(local.notificationFrequency).toBeUndefined();
  });
});

describe('BUG-007: retry policy', () => {
  test('retries a GET on 503 with exponential backoff, then succeeds', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockReturnValueOnce(jsonResponse({ detail: 'overloaded' }, 503))
      .mockReturnValueOnce(jsonResponse({ detail: 'overloaded' }, 503))
      .mockReturnValueOnce(jsonResponse([validHabit()]));

    const promise = habits.list();
    // Run all pending timers so the two backoffs fire without real wall clock.
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1);
  });

  test('gives up after max retries and surfaces the real server detail', async () => {
    jest.useFakeTimers();
    mockFetch.mockReturnValue(jsonResponse({ detail: 'overloaded' }, 503));
    const promise = habits.list();
    // Silently handle the eventual rejection so Jest does not print
    // "Unhandled Promise Rejection" before we attach the assertion.
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      detail: 'overloaded',
    });
    // Initial + 2 retries = 3 total.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('does NOT retry a POST (non-idempotent) even on a transient 502', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'bad gateway' }, 502));
    await expect(
      practiceSessions.create({
        user_practice_id: 1,
        started_at: '2026-04-28T10:00:00.000Z',
        ended_at: '2026-04-28T10:10:00.000Z',
      }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 502 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('retries a POST when the caller supplies X-Idempotency-Key', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockReturnValueOnce(jsonResponse({ detail: 'overloaded' }, 503))
      .mockReturnValueOnce(jsonResponse({ total_cost: 0, total_return: 0, plan: [] }));
    const promise = energy.createPlan(
      { habits: [], start_date: '2026-04-15' },
      'idempotency-key-abc',
    );
    await jest.runAllTimersAsync();
    await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('BUG-001: fetch timeout via AbortController', () => {
  test('raises ApiTimeoutError when no response arrives before the default window', async () => {
    jest.useFakeTimers();
    // Return a fetch that resolves only when its signal aborts.
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = habits.list();
    // Swallow the rejection so Jest doesn't flag it as unhandled while we
    // let fake timers drain all three attempts + two backoffs.
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    // Ensure the timeout consistently holds to FETCH_TIMEOUT_MS (smoke).
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });

  test('attaches a signal to every fetch invocation', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([validHabit()]));
    await habits.list();
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

function sampleGoal(
  overrides: Partial<ApiHabitWithGoals['goals'][number]> = {},
): ApiHabitWithGoals['goals'][number] {
  return {
    id: 10,
    habit_id: 1,
    title: 'Low',
    tier: 'low',
    target: 1,
    target_unit: 'reps',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
    ...overrides,
  };
}

// Keep ApiError available for the test runner without importing unused
// symbols from the module under test.
void ApiError;
