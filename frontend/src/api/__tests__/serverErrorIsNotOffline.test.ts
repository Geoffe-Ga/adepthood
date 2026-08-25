/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
/**
 * A 500 that arrived is not the same event as a request that never landed.
 *
 * The backend's unhandled-exception envelope used to be written above
 * `CORSMiddleware`, so a browser discarded it before JavaScript could read the
 * status and `fetch` rejected with a bare `TypeError` — indistinguishable from
 * a dead network. The app then told people to check their wifi while the
 * server was up, answering, and logging the real fault.
 *
 * These cases pin the client side of that seam: the sanitised
 * `{error, request_id}` envelope has to become an `ApiError` carrying the
 * server's own error code and request id — the value that turns "it broke" into
 * a log lookup — and only a failure that produced no response at all may still
 * read as "you appear to be offline".
 */
import { formatApiError, USER_FACING_ERROR_MESSAGES } from '../errorMessages';
import { habits, setNetworkOnlineGetter, setOnUnauthorized, setTokenGetter } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const REQUEST_ID = 'a1b2c3d4e5f60718';
const SERVER_500_COPY =
  'Something went wrong on our end. Give it a moment and try again — if it keeps happening, let us know.';

/** The sanitised body `errors._sanitized_500` returns — no detail, by design. */
const SANITISED_ENVELOPE = { error: 'internal_error', request_id: REQUEST_ID };

/**
 * A response shaped like the one a browser hands back once the 500 carries its
 * CORS headers: readable status, readable body, and the exposed `X-Request-ID`.
 */
function serverErrorResponse(body: unknown = SANITISED_ENVELOPE) {
  return Promise.resolve({
    ok: false,
    status: 500,
    headers: new Headers({ 'X-Request-ID': REQUEST_ID }),
    json: () => Promise.resolve(body),
  });
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  mockFetch.mockReset();
  setTokenGetter(null);
  setOnUnauthorized(null);
  // Affirmatively online: the incident happened on a machine whose network was
  // fine, so nothing here may lean on the offline fast-fail path.
  setNetworkOnlineGetter(() => true);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  setNetworkOnlineGetter(null);
});

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err: unknown) {
    return err as Error;
  }
  throw new Error('expected the request to reject');
}

describe('a 500 that reached the client', () => {
  test('surfaces the server-error copy, never the offline copy', async () => {
    mockFetch.mockReturnValue(serverErrorResponse());

    const err = await failureOf(habits.list());

    expect(formatApiError(err)).toContain(SERVER_500_COPY);
    expect(formatApiError(err)).not.toContain(USER_FACING_ERROR_MESSAGES.network_error);
  });

  test('keeps the sanitised error code as the detail instead of a placeholder', async () => {
    mockFetch.mockReturnValue(serverErrorResponse());

    const err = await failureOf(habits.list());

    expect(err).toMatchObject({ name: 'ApiError', status: 500, detail: 'internal_error' });
  });

  test('carries the request id so a user report can be looked up in the logs', async () => {
    mockFetch.mockReturnValue(serverErrorResponse());

    const err = await failureOf(habits.list());

    expect(err).toMatchObject({ requestId: REQUEST_ID });
  });

  test('logs the request id client-side', async () => {
    mockFetch.mockReturnValue(serverErrorResponse());

    await failureOf(habits.list());

    const logged = warnSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(logged).toContain(REQUEST_ID);
  });

  test('recovers the request id from the exposed header when the body is not JSON', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        headers: new Headers({ 'X-Request-ID': REQUEST_ID }),
        json: () => Promise.reject(new Error('not json')),
      }),
    );

    const err = await failureOf(habits.list());

    expect(err).toMatchObject({ status: 500, requestId: REQUEST_ID });
  });

  test('offers the request id to the user as a reference to quote', async () => {
    mockFetch.mockReturnValue(serverErrorResponse());

    const err = await failureOf(habits.list());

    expect(formatApiError(err)).toContain(SERVER_500_COPY);
    expect(formatApiError(err)).toContain(REQUEST_ID);
  });
});

describe('a request that produced no response at all', () => {
  test('still reports as offline', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await failureOf(habits.list());

    expect(formatApiError(err)).toBe(USER_FACING_ERROR_MESSAGES.network_error);
  });

  test('carries no request id to quote', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));

    const err = await failureOf(habits.list());

    expect(formatApiError(err)).not.toContain(REQUEST_ID);
  });
});

describe('errors that are not the server’s fault', () => {
  test('a 404 keeps its own detail and gains no reference id', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 404,
        headers: new Headers({ 'X-Request-ID': REQUEST_ID }),
        json: () => Promise.resolve({ detail: 'habit_not_found' }),
      }),
    );

    const err = await failureOf(habits.list());

    expect(err).toMatchObject({ status: 404, detail: 'habit_not_found' });
    expect(formatApiError(err)).not.toContain(REQUEST_ID);
  });
});
