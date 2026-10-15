import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';

import { goalCompletions, setOnTokenRefreshed, setOnUnauthorized, setTokenGetter } from '../index';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
const fetchMock = jest.fn<typeof fetch>();
const previousFetch = globalThis.fetch;
const unauthorized = jest.fn();
const tokenFor = (owner: number, version = 1) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000, jti: String(version) })).replace(/=+$/u, '')}.sig`;
const completed = { streak: 1, day_units: 1, reason_code: 'logged', milestones: [] };
const payload = { goal_id: 421, did_complete: true };
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
beforeEach(() => {
  fetchMock.mockReset();
  unauthorized.mockReset();
  globalThis.fetch = fetchMock;
  setTokenGetter(() => tokenFor(1));
  setOnUnauthorized(unauthorized);
  setOnTokenRefreshed(null);
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  setTokenGetter(null);
  setOnUnauthorized(null);
  setOnTokenRefreshed(null);
});

it('renews a captured current-session credential and retries the same signed mutation', async () => {
  let live = tokenFor(1);
  const renewed = tokenFor(1, 2);
  setTokenGetter(() => live);
  setOnTokenRefreshed((next) => {
    live = next;
  });
  fetchMock
    .mockResolvedValueOnce(response({ detail: 'session_expired' }, 401))
    .mockResolvedValueOnce(response({ token: renewed, user_id: 1, timezone: 'UTC' }))
    .mockResolvedValueOnce(response(completed));
  await expect(goalCompletions.create(payload, { token: live })).resolves.toEqual(completed);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    'http://test/goal_completions/',
    'http://test/auth/refresh',
    'http://test/goal_completions/',
  ]);
  expect(
    fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization),
  ).toEqual([`Bearer ${tokenFor(1)}`, `Bearer ${tokenFor(1)}`, `Bearer ${renewed}`]);
  expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  expect(unauthorized).not.toHaveBeenCalled();
});

it('never refreshes a foreign explicit token through the incoming session', async () => {
  setTokenGetter(() => tokenFor(2));
  fetchMock.mockResolvedValueOnce(response({ detail: 'session_expired' }, 401));
  await expect(goalCompletions.create(payload, { token: tokenFor(1) })).rejects.toMatchObject({
    status: 401,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(unauthorized).not.toHaveBeenCalled();
});

it('does not renew or sign out the incoming session after the initiating account leaves', async () => {
  const held = deferred<Response>();
  fetchMock.mockReturnValueOnce(held.promise);
  const posting = goalCompletions.create(payload, { token: tokenFor(1) });
  setTokenGetter(() => tokenFor(2));
  held.resolve(response({ detail: 'session_expired' }, 401));
  await expect(posting).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(unauthorized).not.toHaveBeenCalled();
});

it('reports one expiration after renewal of the captured current session really fails', async () => {
  fetchMock
    .mockResolvedValueOnce(response({ detail: 'session_expired' }, 401))
    .mockResolvedValueOnce(response({ detail: 'session_expired' }, 401));
  await expect(goalCompletions.create(payload, { token: tokenFor(1) })).rejects.toMatchObject({
    status: 401,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(unauthorized).toHaveBeenCalledTimes(1);
  expect(unauthorized).toHaveBeenCalledWith('session_expired');
});
