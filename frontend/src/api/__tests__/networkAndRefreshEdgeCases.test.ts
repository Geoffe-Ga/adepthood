/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import {
  habits,
  goalCompletions,
  practiceSessions,
  setTokenGetter,
  setOnUnauthorized,
  setNetworkOnlineGetter,
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

const mockOnUnauthorized = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockOnUnauthorized.mockReset();
  setTokenGetter(null);
  setOnUnauthorized(null);
  setNetworkOnlineGetter(null);
});

afterEach(() => {
  jest.useRealTimers();
  setNetworkOnlineGetter(null);
});

describe('known-offline fast fail', () => {
  test('rejects a GET immediately without calling fetch when known offline', async () => {
    setNetworkOnlineGetter(() => false);

    await expect(habits.list()).rejects.toMatchObject({ name: 'ApiError', status: 0 });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('proceeds with a GET when the online getter reports true', async () => {
    setNetworkOnlineGetter(() => true);
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    const result = await habits.list();

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not fast-fail a non-GET request even when known offline', async () => {
    setNetworkOnlineGetter(() => false);
    mockFetch.mockReturnValueOnce(jsonResponse({ streak: 1, milestones: [], reason_code: 'ok' }));

    const result = await goalCompletions.create({ goal_id: 1, did_complete: true });

    expect(result.streak).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('malformed /auth/refresh response body', () => {
  test('treats a schema-invalid refresh body as a refresh failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setTokenGetter(() => 'stored-token');
    setOnUnauthorized(mockOnUnauthorized);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));
    mockFetch.mockReturnValueOnce(jsonResponse({ token: 'not-a-jwt', user_id: 1 }));

    await expect(habits.list()).rejects.toMatchObject({ name: 'ApiError' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockOnUnauthorized).toHaveBeenCalledWith('session_expired');
    warnSpy.mockRestore();
  });
});

describe('explicit token override matching the live session', () => {
  test('fires onUnauthorized when the override equals the live session token', async () => {
    setTokenGetter(() => 'shared-token');
    setOnUnauthorized(mockOnUnauthorized);
    mockFetch.mockReturnValueOnce(jsonResponse({ detail: 'unauthorized' }, 401));

    await expect(habits.list('shared-token')).rejects.toMatchObject({ name: 'ApiError' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockOnUnauthorized).toHaveBeenCalledWith('session_expired');
  });
});

describe('fetch rejecting with a raw exception (not an HTTP error status)', () => {
  test('retries a GET after a network-level TypeError and succeeds', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockImplementationOnce(() => Promise.reject(new TypeError('Network request failed')))
      .mockReturnValueOnce(jsonResponse([]));

    const promise = habits.list();
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('does not retry a non-idempotent POST after a network-level TypeError', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError('Network request failed')));

    await expect(
      practiceSessions.create({
        user_practice_id: 1,
        started_at: '2026-04-28T10:00:00.000Z',
        ended_at: '2026-04-28T10:10:00.000Z',
      }),
    ).rejects.toThrow(TypeError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry a GET when fetch rejects with a non-Error value', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject('boom'));

    await expect(habits.list()).rejects.toBe('boom');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('error responses without a usable JSON detail', () => {
  test('falls back to a generic message when the error body is not JSON', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.reject(new Error('not json')),
      }),
    );

    await expect(habits.getStats(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      detail: 'Request failed',
    });
  });

  test('falls back to a generic message when the error body has no detail string', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    );

    await expect(habits.getStats(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      detail: 'Request failed',
    });
  });
});

/**
 * FastAPI answers a Pydantic rejection with an array-form ``detail``:
 * ``[{loc, msg, type, input?, ctx?}]``. Only ``msg`` is safe to surface —
 * ``input`` echoes back whatever the user submitted (which, on signup, is
 * their license key) and ``loc`` leaks internal field names.
 */
describe('array-form Pydantic error detail', () => {
  const LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
  const TOO_LONG_MSG = 'String should have at most 128 characters';

  function rejectWith(detail: unknown, status = 422) {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: false, status, json: () => Promise.resolve({ detail }) }),
    );
  }

  async function detailOf(promise: Promise<unknown>): Promise<string> {
    let captured: string | undefined;
    await promise.catch((err: { detail?: string }) => {
      captured = err.detail;
    });
    expect(typeof captured).toBe('string');
    return captured as string;
  }

  test('uses the msg of a single entry as the detail', async () => {
    rejectWith([{ loc: ['body', 'license_key'], msg: TOO_LONG_MSG, type: 'string_too_long' }]);

    await expect(habits.getStats(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      detail: TOO_LONG_MSG,
    });
  });

  test('joins multiple entries with a semicolon', async () => {
    rejectWith([
      { loc: ['body', 'email'], msg: 'Field required', type: 'missing' },
      { loc: ['body', 'license_key'], msg: TOO_LONG_MSG, type: 'string_too_long' },
    ]);

    expect(await detailOf(habits.getStats(1))).toBe(`Field required; ${TOO_LONG_MSG}`);
  });

  test('falls back to a generic message when no entry carries a string msg', async () => {
    rejectWith([{ loc: ['body', 'license_key'], type: 'missing' }, { msg: 42 }]);

    expect(await detailOf(habits.getStats(1))).toBe('Request failed');
  });

  test('falls back to a generic message for an empty array', async () => {
    rejectWith([]);

    expect(await detailOf(habits.getStats(1))).toBe('Request failed');
  });

  test('never echoes the submitted input or the ctx object back to the client', async () => {
    rejectWith([
      {
        loc: ['body', 'license_key'],
        msg: TOO_LONG_MSG,
        type: 'string_too_long',
        input: LICENSE_KEY,
        ctx: { max_length: 128 },
      },
    ]);

    const detail = await detailOf(habits.getStats(1));

    expect(detail).toBe(TOO_LONG_MSG);
    expect(detail).not.toContain(LICENSE_KEY);
    expect(detail).not.toContain('license_key');
    expect(detail).not.toContain('max_length');
  });

  test('still prefers a plain string detail over the array branch', async () => {
    rejectWith('license_required', 400);

    await expect(habits.getStats(1)).rejects.toMatchObject({
      status: 400,
      detail: 'license_required',
    });
  });
});
