/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
/**
 * A request the browser refused to make is not proof that the device is offline.
 *
 * #2661 arrived through the login form of a local web build served from
 * `http://127.0.0.1:8080`, a loopback spelling the development CORS allow-list
 * did not name. The backend was running and answering; the browser blocked the
 * response and the app told the developer they appeared to be offline.
 *
 * The allow-list is fixed on the server side, but the copy was wrong for a
 * whole family of causes, so it is fixed here too. What the client can actually
 * observe was measured in a real Chromium (see the PR body): a CORS rejection,
 * a refused connection and an unroutable host all reject `fetch` with exactly
 * `TypeError: Failed to fetch`, own properties `["stack", "message"]`, no
 * `cause`, no status, and a resource-timing entry with `responseStatus: 0`.
 * There is no signal to tell them apart, and there never will be — hiding the
 * difference is the point of the same-origin policy.
 *
 * So the client stops claiming to know. It asserts the device is offline only
 * when its own connectivity signal (`setNetworkOnlineGetter`, fed by NetInfo in
 * `NetworkStatusContext`) says so — the one observable that *did* differ in the
 * measurement — and otherwise says only what is true: the server was not
 * reached.
 */
import { formatApiError, UNREACHABLE_MESSAGE, USER_FACING_ERROR_MESSAGES } from '../errorMessages';
import { auth, setNetworkOnlineGetter, setOnUnauthorized, setTokenGetter } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const CREDENTIALS = { email: 'reader@example.com', password: PASSWORD };

/**
 * The rejections a blocked `fetch` produces, by engine. Every one of them is
 * also what a dead network produces on that engine — that is the point.
 */
const ENGINE_FETCH_FAILURES: ReadonlyArray<readonly [string, string]> = [
  ['Chrome/Blink', 'Failed to fetch'],
  ['Safari/WebKit', 'Load failed'],
  ['Firefox', 'NetworkError when attempting to fetch resource.'],
  ['React Native', 'Network request failed'],
];

beforeEach(() => {
  mockFetch.mockReset();
  setTokenGetter(null);
  setOnUnauthorized(null);
});

afterEach(() => {
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

describe('a login the browser blocked while the device was online', () => {
  beforeEach(() => {
    // The reproduction machine's network was fine: the backend was up on
    // :8000 and the page had just loaded from :8080.
    setNetworkOnlineGetter(() => true);
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
  });

  test('does not tell the developer they appear to be offline', async () => {
    const err = await failureOf(auth.login(CREDENTIALS));

    expect(formatApiError(err)).not.toContain('offline');
  });

  test('says the server was not reached, which is all that is known', async () => {
    const err = await failureOf(auth.login(CREDENTIALS));

    expect(formatApiError(err)).toBe(UNREACHABLE_MESSAGE);
  });

  test.each(ENGINE_FETCH_FAILURES)(
    'reads the same on %s, which cannot tell CORS from a dead network either',
    async (_engine, message) => {
      mockFetch.mockRejectedValue(new TypeError(message));

      const err = await failureOf(auth.login(CREDENTIALS));

      expect(formatApiError(err)).toBe(UNREACHABLE_MESSAGE);
    },
  );
});

describe('a login that failed while the device was known to be offline', () => {
  test('still says so, because that is the one thing the client can observe', async () => {
    setNetworkOnlineGetter(() => false);
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await failureOf(auth.login(CREDENTIALS));

    expect(formatApiError(err)).toBe(USER_FACING_ERROR_MESSAGES.network_error);
    expect(formatApiError(err)).toContain('offline');
  });
});

describe('when nothing has registered a connectivity signal', () => {
  test('claims nothing about the device', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await failureOf(auth.login(CREDENTIALS));

    expect(formatApiError(err)).toBe(UNREACHABLE_MESSAGE);
  });
});
