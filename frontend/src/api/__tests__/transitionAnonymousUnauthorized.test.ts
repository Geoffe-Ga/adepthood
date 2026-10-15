import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';

import { beginActiveUserTransition, setActiveUser } from '../../storage/userScope';
import { journal, setOnUnauthorized, setTokenGetter } from '../index';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

/**
 * #3366 at the client seam: a credential-less request only reports
 * ``not_authenticated`` when its anonymity was real — sent and failed in one
 * settled user scope. The AuthContext-level race lives in
 * ``context/__tests__/TransitionAnonymousUnauthorized.integration.test.tsx``.
 */
const fetchMock = jest.fn<typeof fetch>();
const previousFetch = globalThis.fetch;
const unauthorized = jest.fn();
const USER_A = 1;
const USER_B = 2;
const ENTRY_ID = 9;
const HTTP_UNAUTHORIZED = 401;
const patch = { message: 'draft' };

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: HTTP_UNAUTHORIZED,
    json: async () => ({ detail: 'not_authenticated' }),
  } as Response;
}

function heldResponse() {
  let resolve!: (_value: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  fetchMock.mockReturnValueOnce(promise);
  return () => resolve(unauthorizedResponse());
}

beforeEach(() => {
  fetchMock.mockReset();
  unauthorized.mockReset();
  globalThis.fetch = fetchMock;
  setActiveUser(null);
  setTokenGetter(() => null);
  setOnUnauthorized(unauthorized);
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  setActiveUser(null);
  setTokenGetter(null);
  setOnUnauthorized(null);
});

it('control: a genuinely anonymous 401 still reports not_authenticated', async () => {
  fetchMock.mockResolvedValueOnce(unauthorizedResponse());
  await expect(journal.update(ENTRY_ID, patch)).rejects.toMatchObject({
    status: HTTP_UNAUTHORIZED,
  });
  expect(unauthorized).toHaveBeenCalledTimes(1);
  expect(unauthorized).toHaveBeenCalledWith('not_authenticated');
});

it('a request sent anonymous by a transition never reports, even after the scope settles', async () => {
  setActiveUser(USER_A);
  beginActiveUserTransition();
  const land = heldResponse();
  const saving = journal.update(ENTRY_ID, patch);
  setActiveUser(USER_B);
  land();
  await expect(saving).rejects.toMatchObject({ status: HTTP_UNAUTHORIZED });
  const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
  expect(headers.Authorization).toBeUndefined();
  expect(unauthorized).not.toHaveBeenCalled();
});

it('a request sent during a transition stays silent even when the scope settles on the same owner', async () => {
  setActiveUser(USER_A);
  beginActiveUserTransition();
  const land = heldResponse();
  const saving = journal.update(ENTRY_ID, patch);
  // Settling back on the same owner ends the transition without a new generation.
  setActiveUser(USER_A);
  land();
  await expect(saving).rejects.toMatchObject({ status: HTTP_UNAUTHORIZED });
  expect(unauthorized).not.toHaveBeenCalled();
});

it('an anonymous 401 that lands during a transition does not report', async () => {
  const land = heldResponse();
  const saving = journal.update(ENTRY_ID, patch);
  beginActiveUserTransition();
  land();
  await expect(saving).rejects.toMatchObject({ status: HTTP_UNAUTHORIZED });
  expect(unauthorized).not.toHaveBeenCalled();
});

it('an anonymous 401 that lands after another account was adopted does not report', async () => {
  const land = heldResponse();
  const saving = journal.update(ENTRY_ID, patch);
  setActiveUser(USER_B);
  land();
  await expect(saving).rejects.toMatchObject({ status: HTTP_UNAUTHORIZED });
  expect(unauthorized).not.toHaveBeenCalled();
});
