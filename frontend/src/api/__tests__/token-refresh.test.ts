/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import {
  habits,
  auth,
  refreshSessionToken,
  resetTokenRotations,
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

    // The in-flight promise cleared on settle: a later, GENUINE refresh still
    // fires -- for the session's current token. Before #3034 this tail
    // re-sent the already-rotated ``original-token`` to /auth/refresh, which
    // the server has revoked by then; the client now knows the rotation and
    // only refreshes the token the session actually holds.
    capturedToken = newJwt;
    const secondJwt = fixtureJwt('second');
    refreshed = false;
    refreshCalls = 0;
    const refreshAuth: unknown[] = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        refreshed = true;
        refreshAuth.push((init?.headers as Record<string, string>).Authorization);
        return jsonResponse({ token: secondJwt, user_id: 1 });
      }
      return refreshed ? jsonResponse([]) : jsonResponse({ detail: 'unauthorized' }, 401);
    });
    await habits.list();
    expect(refreshCalls).toBe(1);
    expect(refreshAuth).toEqual([`Bearer ${newJwt}`]);
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

type FetchReply = ReturnType<typeof jsonResponse>;

/** A response the test releases by hand, so 401s can land at a chosen moment. */
function deferredReply(): {
  promise: FetchReply;
  release: (data: unknown, status?: number) => void;
} {
  let resolveReply: (value: Awaited<FetchReply>) => void = () => {};
  const promise = new Promise<Awaited<FetchReply>>((resolve) => {
    resolveReply = resolve;
  });
  return {
    promise,
    release: (data, status = 200) => {
      void jsonResponse(data, status).then(resolveReply);
    },
  };
}

function authOf(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

/** Let every queued microtask (and the fetch mocks chained on them) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

/**
 * A fake server that revokes a token the moment it is refreshed, and serves
 * the FIRST refresh only: any second POST /auth/refresh is the production
 * 1/minute limiter's 429 (#3034). ``first`` may still be refreshed, but data
 * routes already refuse it -- the resumed token whose access has lapsed.
 */
function rotatingServer(first: string, successor: string) {
  const dataRefused = new Set<string>([first]);
  const state = {
    refreshCalls: 0,
    refreshAuth: [] as (string | undefined)[],
    dataAuth: [] as (string | undefined)[],
    live: new Set<string>([first]),
  };
  const handler = (url: string, init?: RequestInit): FetchReply => {
    const bearer = authOf(init)?.replace('Bearer ', '');
    if (url.includes('/auth/refresh')) {
      state.refreshCalls += 1;
      state.refreshAuth.push(authOf(init));
      if (state.refreshCalls > 1) return jsonResponse({ detail: 'rate_limited' }, 429);
      if (bearer === undefined || !state.live.has(bearer)) {
        return jsonResponse({ detail: 'unauthorized' }, 401);
      }
      state.live.delete(bearer);
      state.live.add(successor);
      return jsonResponse({ token: successor, user_id: 1 });
    }
    state.dataAuth.push(authOf(init));
    return bearer !== undefined && state.live.has(bearer) && !dataRefused.has(bearer)
      ? jsonResponse([])
      : jsonResponse({ detail: 'unauthorized' }, 401);
  };
  return { state, handler };
}

describe('token rotation memory (#3034)', () => {
  test('a 401 on a superseded token retries with its successor instead of refreshing again', async () => {
    const rotated = fixtureJwt('rotated');
    const authHeaders: (string | undefined)[] = [];
    let refreshCalls = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? jsonResponse({ token: rotated, user_id: 1 })
          : jsonResponse({ detail: 'rate_limited' }, 429);
      }
      authHeaders.push(authOf(init));
      return authOf(init) === `Bearer ${rotated}`
        ? jsonResponse([])
        : jsonResponse({ detail: 'unauthorized' }, 401);
    });

    await habits.list();
    // The getter still answers 'original-token': React has not re-rendered.
    const second = await habits.list();

    expect(refreshCalls).toBe(1);
    expect(second).toEqual([]);
    expect(authHeaders.slice(1)).toEqual(
      Array.from({ length: authHeaders.length - 1 }, () => `Bearer ${rotated}`),
    );
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('a request issued before the getter catches up already carries the successor', async () => {
    const rotated = fixtureJwt('window');
    const server = rotatingServer('original-token', rotated);
    mockFetch.mockImplementation(server.handler);

    await habits.list();
    const callsBefore = mockFetch.mock.calls.length;
    await habits.list();

    // One request, first attempt, already on the successor -- never the
    // revoked token, even though ``tokenGetter()`` still returns it.
    expect(mockFetch.mock.calls.length - callsBefore).toBe(1);
    expect(authOf(mockFetch.mock.calls[callsBefore][1])).toBe(`Bearer ${rotated}`);
    expect(server.state.refreshCalls).toBe(1);
  });

  test('a 401 carrying the old token after the getter moved on retries once with the successor', async () => {
    const rotated = fixtureJwt('late');
    mockOnTokenRefreshed.mockImplementation((token: string) => {
      capturedToken = token;
    });
    const server = rotatingServer('original-token', rotated);
    const held = deferredReply();
    let holdFirst = true;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!url.includes('/auth/refresh') && holdFirst) {
        holdFirst = false;
        server.state.dataAuth.push(authOf(init));
        return held.promise;
      }
      return server.handler(url, init);
    });

    const slow = habits.list();
    await flushMicrotasks();
    await habits.list(); // 401 -> refresh A->B -> retry on B; getter now B
    expect(capturedToken).toBe(rotated);

    held.release({ detail: 'unauthorized' }, 401); // the old token's 401 lands late
    await expect(slow).resolves.toEqual([]);

    expect(server.state.refreshCalls).toBe(1);
    expect(server.state.dataAuth.at(-1)).toBe(`Bearer ${rotated}`);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('a backfill racing three concurrent 401s puts exactly one refresh on the wire', async () => {
    const rotated = fixtureJwt('resume');
    const server = rotatingServer('original-token', rotated);
    const refreshReply = deferredReply();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh') && server.state.refreshCalls === 0) {
        server.state.refreshCalls += 1;
        server.state.refreshAuth.push(authOf(init));
        return refreshReply.promise;
      }
      return server.handler(url, init);
    });

    const backfill = refreshSessionToken('original-token');
    const wave = [habits.list(), habits.list(), habits.list()];
    await flushMicrotasks();
    refreshReply.release({ token: rotated, user_id: 1, timezone: 'America/Los_Angeles' });
    server.state.live.delete('original-token');
    server.state.live.add(rotated);

    await expect(backfill).resolves.toMatchObject({ token: rotated });
    await expect(Promise.all(wave)).resolves.toEqual([[], [], []]);
    expect(server.state.refreshCalls).toBe(1);
    expect(server.state.refreshAuth).toEqual(['Bearer original-token']);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
    expect(mockOnTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(mockOnTokenRefreshed).toHaveBeenCalledWith(
      rotated,
      'America/Los_Angeles',
      'original-token',
    );
  });

  test('a backfill that settled before the wave 401s still leaves the count at one', async () => {
    const rotated = fixtureJwt('after');
    const server = rotatingServer('original-token', rotated);
    const held = [deferredReply(), deferredReply(), deferredReply()];
    let next = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const reply = url.includes('/auth/refresh') ? undefined : held[next];
      if (reply !== undefined) {
        server.state.dataAuth.push(authOf(init));
        next += 1;
        return reply.promise;
      }
      return server.handler(url, init);
    });

    const wave = [habits.list(), habits.list(), habits.list()];
    await flushMicrotasks();
    await expect(refreshSessionToken('original-token')).resolves.toMatchObject({
      token: rotated,
    });
    for (const reply of held) reply.release({ detail: 'unauthorized' }, 401);

    await expect(Promise.all(wave)).resolves.toEqual([[], [], []]);
    expect(server.state.refreshCalls).toBe(1);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('refreshing a token that is already rotated is answered without the network', async () => {
    const rotated = fixtureJwt('known');
    const server = rotatingServer('original-token', rotated);
    mockFetch.mockImplementation(server.handler);

    await refreshSessionToken('original-token');
    await expect(refreshSessionToken('original-token')).rejects.toThrow(ApiError);

    expect(server.state.refreshCalls).toBe(1);
  });

  test('refreshing a token that is neither current nor known never reaches the network', async () => {
    await expect(refreshSessionToken('someone-elses-token')).rejects.toThrow(ApiError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a refresh that fails after the session moved on is not a sign-out', async () => {
    const refreshReply = deferredReply();
    mockFetch.mockImplementation((url: string) =>
      url.includes('/auth/refresh')
        ? refreshReply.promise
        : jsonResponse({ detail: 'unauthorized' }, 401),
    );

    const pending = habits.list();
    pending.catch(() => {});
    await flushMicrotasks();
    // A fresh sign-in replaced the session while the refresh was in flight.
    resetTokenRotations();
    capturedToken = 'fresh-session-token';
    refreshReply.release({ detail: 'rate_limited' }, 429);

    await expect(pending).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
    const sent = mockFetch.mock.calls.map(([, init]) => authOf(init as RequestInit));
    expect(sent).not.toContain('Bearer fresh-session-token');
  });

  test('a refresh that succeeds after a session switch is neither recorded nor published', async () => {
    const stale = fixtureJwt('stale');
    const refreshReply = deferredReply();
    mockFetch.mockImplementation((url: string) =>
      url.includes('/auth/refresh')
        ? refreshReply.promise
        : jsonResponse({ detail: 'unauthorized' }, 401),
    );

    const pending = habits.list();
    pending.catch(() => {});
    await flushMicrotasks();
    resetTokenRotations();
    capturedToken = 'fresh-session-token';
    refreshReply.release({ token: stale, user_id: 1 });

    await expect(pending).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
    expect(mockOnTokenRefreshed).not.toHaveBeenCalled();
    const sent = mockFetch.mock.calls.map(([, init]) => authOf(init as RequestInit));
    expect(sent).not.toContain(`Bearer ${stale}`);
  });

  test('the current token failing to refresh still signs the session out', async () => {
    mockFetch.mockImplementation((url: string) =>
      url.includes('/auth/refresh')
        ? jsonResponse({ detail: 'unauthorized' }, 401)
        : jsonResponse({ detail: 'unauthorized' }, 401),
    );

    await expect(habits.list()).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).toHaveBeenCalledTimes(1);
    expect(mockOnUnauthorized).toHaveBeenCalledWith('session_expired');
  });

  test('a late 401 from a prior session never borrows that session successor', async () => {
    const rotated = fixtureJwt('prior');
    const server = rotatingServer('original-token', rotated);
    const held = deferredReply();
    let holdFirst = true;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!url.includes('/auth/refresh') && holdFirst) {
        holdFirst = false;
        return held.promise;
      }
      return server.handler(url, init);
    });

    const late = habits.list();
    late.catch(() => {});
    await flushMicrotasks();
    await habits.list(); // rotates original-token -> rotated
    // Sign out, then a different account signs in.
    resetTokenRotations();
    capturedToken = 'other-account-token';
    const callsBefore = mockFetch.mock.calls.length;
    held.release({ detail: 'unauthorized' }, 401);

    await expect(late).rejects.toThrow(ApiError);
    const after = mockFetch.mock.calls.slice(callsBefore).map(([, init]) => authOf(init));
    expect(after).toEqual([]);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('a retry 401 after the session moved on is not a sign-out', async () => {
    const rotated = fixtureJwt('retry');
    const retryReply = deferredReply();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) return jsonResponse({ token: rotated, user_id: 1 });
      return authOf(init) === `Bearer ${rotated}`
        ? retryReply.promise
        : jsonResponse({ detail: 'unauthorized' }, 401);
    });

    const pending = habits.list();
    pending.catch(() => {});
    await flushMicrotasks();
    resetTokenRotations();
    capturedToken = 'other-account-token';
    retryReply.release({ detail: 'unauthorized' }, 401);

    await expect(pending).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('installing a token getter forgets every remembered rotation', async () => {
    const rotated = fixtureJwt('forgotten');
    const server = rotatingServer('original-token', rotated);
    mockFetch.mockImplementation(server.handler);
    await habits.list(); // remembers original-token -> rotated

    setTokenGetter(() => capturedToken);
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => jsonResponse([]));
    await habits.list();

    expect(authOf(mockFetch.mock.calls[0][1])).toBe('Bearer original-token');
  });

  test('an anonymous request whose 401 lands after a sign-in is not a sign-out', async () => {
    capturedToken = null;
    const held = deferredReply();
    mockFetch.mockImplementation(() => held.promise);

    const pending = habits.list();
    pending.catch(() => {});
    await flushMicrotasks();
    capturedToken = 'signed-in-token';
    held.release({ detail: 'unauthorized' }, 401);

    await expect(pending).rejects.toThrow(ApiError);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('an explicit session token whose 401 lands mid-refresh rides that refresh, not a sign-out', async () => {
    const rotated = fixtureJwt('explicit');
    const server = rotatingServer('original-token', rotated);
    const refreshReply = deferredReply();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh') && server.state.refreshCalls === 0) {
        server.state.refreshCalls += 1;
        server.state.live.delete('original-token');
        server.state.live.add(rotated);
        return refreshReply.promise;
      }
      return server.handler(url, init);
    });

    const backfill = refreshSessionToken('original-token');
    // A store that read the token from the auth context passes it explicitly.
    const explicit = habits.list('original-token');
    await flushMicrotasks();
    refreshReply.release({ token: rotated, user_id: 1 });

    await expect(backfill).resolves.toMatchObject({ token: rotated });
    await expect(explicit).resolves.toEqual([]);
    expect(server.state.refreshCalls).toBe(1);
    expect(server.state.dataAuth).toEqual(['Bearer original-token', `Bearer ${rotated}`]);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('an explicit session token is forwarded once its rotation is known', async () => {
    const rotated = fixtureJwt('explicitfwd');
    const server = rotatingServer('original-token', rotated);
    mockFetch.mockImplementation(server.handler);
    await refreshSessionToken('original-token');

    await expect(habits.list('original-token')).resolves.toEqual([]);

    expect(server.state.dataAuth).toEqual([`Bearer ${rotated}`]);
    expect(server.state.refreshCalls).toBe(1);
  });

  test('a late 401 on an explicit session token is retried on the known successor', async () => {
    const rotated = fixtureJwt('explicitlate');
    const server = rotatingServer('original-token', rotated);
    const held = deferredReply();
    let holdFirst = true;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!url.includes('/auth/refresh') && holdFirst) {
        holdFirst = false;
        server.state.dataAuth.push(authOf(init));
        return held.promise;
      }
      return server.handler(url, init);
    });

    const explicit = habits.list('original-token');
    await flushMicrotasks();
    await refreshSessionToken('original-token');
    held.release({ detail: 'unauthorized' }, 401);

    await expect(explicit).resolves.toEqual([]);
    expect(server.state.dataAuth).toEqual(['Bearer original-token', `Bearer ${rotated}`]);
    expect(server.state.refreshCalls).toBe(1);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });

  test('a foreign explicit token is never forwarded to the session successor', async () => {
    const rotated = fixtureJwt('foreign');
    const server = rotatingServer('original-token', rotated);
    mockFetch.mockImplementation(server.handler);
    await refreshSessionToken('original-token');

    await expect(habits.list('manual-token')).rejects.toThrow(ApiError);

    expect(server.state.dataAuth).toEqual(['Bearer manual-token']);
    expect(mockOnUnauthorized).not.toHaveBeenCalled();
  });
});
