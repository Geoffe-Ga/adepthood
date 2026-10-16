/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { useMettaReturn } from '../useMettaReturn';
import { useReturnOfferState } from '../useReturnOfferState';

import { auth as authApi } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import {
  UNAUTHORIZED,
  authFlows,
  createFakeServer,
  deferred,
  ok,
  refusals,
  type Reply,
} from '@/testing/sessionLineageHarness';

/**
 * #3452: the Return offer's actions across a same-account renewal.
 *
 * ``useReturnOfferState`` fenced every answer on the exact JWT, so a
 * proactive refresh, or a request's own 401-refresh-retry, made a confirmed
 * "Begin" look stale: the arc opened on the server, the offer stayed on
 * screen, and the let-go moment never came. It now fences on the session
 * lineage. Nothing below the hook re-checks the session, so its fence is the
 * only thing deciding whether a held answer lands; the refusal cases pin it.
 *
 * The real ``AuthProvider`` and API client run throughout; only ``fetch``,
 * the login call and the secure token store are stubbed.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, Record<string, unknown>>>('@/api');
  return { ...actual, auth: { ...actual.auth, login: jest.fn() } };
});

jest.mock('@/storage/authStorage', () => ({
  saveToken: jest.fn(() => Promise.resolve()),
  loadToken: jest.fn(() => Promise.resolve(null)),
  clearToken: jest.fn(() => Promise.resolve()),
  markLogoutPending: jest.fn(() => Promise.resolve()),
  isLogoutPending: jest.fn(() => Promise.resolve(false)),
  clearLogoutPending: jest.fn(() => Promise.resolve()),
  saveUserTimezone: jest.fn(() => Promise.resolve()),
  loadUserTimezone: jest.fn(() => Promise.resolve('UTC')),
  clearUserTimezone: jest.fn(() => Promise.resolve()),
}));

jest.mock('../contractionSignal', () => ({ useContractionSignalActive: () => true }));

const STATE_PATH = '/metta-return';
const ARC_PATH = '/metta-return/arc';
const DISMISS_PATH = '/metta-return/offer/dismiss';

const OFFER = {
  eligible: true,
  weeks: [],
  arc: null,
  offer_episode: 'episode-A',
  offer_dismissed: false,
  released_habits: [],
};
const ARC = {
  started_at: '2026-10-16T00:00:00Z',
  paused: false,
  week: 1,
  focus: 'self',
  complete: false,
};
const STARTED: Reply = ok(ARC);
/** The server's echo of a decline: set aside, and the offer has closed. */
const DECLINED: Reply = ok({ ...OFFER, eligible: false, offer_dismissed: true });

const server = createFakeServer({ [STATE_PATH]: ok(OFFER) });
const flows = authFlows(jest.mocked(authApi.login));

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/** The Return surface beside the real auth state, signed in, with its offer read. */
async function mountOffer() {
  const view = renderHook(() => ({ auth: useAuth(), ret: useMettaReturn() }), { wrapper });
  const authOf = () => view.result.current.auth;
  const ret = () => view.result.current.ret;
  await waitFor(() => expect(authOf().authStatus).not.toBe('loading'));
  await flows.signIn(authOf, 'first');
  await waitFor(() => expect(ret().offerVisible).toBe(true));
  return { view, authOf, ret };
}

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  resetAllStores();
  await AsyncStorage.clear();
  server.install();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('#3452: the Return offer across a same-account renewal', () => {
  test('a Begin held across a proactive renewal opens the arc and the let-go moment, once', async () => {
    const { authOf, ret } = await mountOffer();
    const started = deferred<Reply>();
    server.answer(ARC_PATH, started.promise);
    let begin!: Promise<void>;
    act(() => {
      begin = ret().start();
    });
    await waitFor(() => expect(server.bearers(ARC_PATH, 'POST')).toHaveLength(1));

    await flows.renew(authOf);
    await act(async () => {
      started.resolve(STARTED);
      await begin;
    });

    expect(ret().arc).toEqual(ARC);
    expect(ret().offerVisible).toBe(false);
    expect(ret().letGoVisible).toBe(true);
    expect(server.bearers(ARC_PATH, 'POST')).toHaveLength(1);
  });

  test('a Begin answered 401 opens the arc on its one retry, and no further', async () => {
    const { authOf, ret } = await mountOffer();
    const first = authOf().token;
    // The retry is held until the renewed credential has rendered, as it would
    // be over a real network round-trip.
    const retried = deferred<Reply>();
    server.answer(ARC_PATH, UNAUTHORIZED, retried.promise);
    let begin!: Promise<void>;
    act(() => {
      begin = ret().start();
    });
    await waitFor(() => expect(server.bearers(ARC_PATH, 'POST')).toHaveLength(2));
    await waitFor(() => expect(authOf().token).not.toBe(first));

    await act(async () => {
      retried.resolve(STARTED);
      await begin;
    });

    expect(ret().arc).toEqual(ARC);
    expect(ret().letGoVisible).toBe(true);
    const sent = server.bearers(ARC_PATH, 'POST');
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });

  test("a decline's confirmation held across a proactive renewal still lands", async () => {
    const { authOf, ret } = await mountOffer();
    const confirmed = deferred<Reply>();
    server.answer(DISMISS_PATH, confirmed.promise);
    let decline!: Promise<void>;
    act(() => {
      decline = ret().dismissOffer();
    });
    await waitFor(() => expect(server.bearers(DISMISS_PATH, 'POST')).toHaveLength(1));
    expect(ret().offerVisible).toBe(false);

    await flows.renew(authOf);
    await act(async () => {
      confirmed.resolve(DECLINED);
      await decline;
    });

    // Only the server's echo says the offer has closed.
    expect(ret().eligible).toBe(false);
    expect(server.bearers(DISMISS_PATH, 'POST')).toHaveLength(1);
  });

  test('a renewal neither rereads the offer nor closes it', async () => {
    const { authOf, ret } = await mountOffer();
    const reads = server.bearers(STATE_PATH).length;

    await flows.renew(authOf);

    expect(server.bearers(STATE_PATH)).toHaveLength(reads);
    expect(ret().offerVisible).toBe(true);
  });
});

describe('#3452: the Return fence still refuses every other boundary', () => {
  test.each(refusals(flows))(
    'a Begin held across %s never opens the arc',
    async (_l, interrupt) => {
      const { authOf, ret } = await mountOffer();
      const started = deferred<Reply>();
      server.answer(ARC_PATH, started.promise);
      let begin!: Promise<void>;
      act(() => {
        begin = ret().start();
      });
      await waitFor(() => expect(server.bearers(ARC_PATH, 'POST')).toHaveLength(1));

      await interrupt(authOf);
      await act(async () => {
        started.resolve(STARTED);
        await begin;
      });

      expect(ret().arc).toBeNull();
      expect(ret().letGoVisible).toBe(false);
    },
  );

  test('the let-go moment closes when the same account signs back in after a 401', async () => {
    const { authOf, ret } = await mountOffer();
    server.answer(ARC_PATH, STARTED);
    await act(async () => {
      await ret().start();
    });
    expect(ret().letGoVisible).toBe(true);

    await flows.reauthenticateSameOwner(authOf);

    expect(ret().letGoVisible).toBe(false);
  });

  test('the fence refuses the moment a 401 ends the session, before any render', async () => {
    const view = renderHook(() => ({ auth: useAuth(), offer: useReturnOfferState() }), {
      wrapper,
    });
    const authOf = () => view.result.current.auth;
    await waitFor(() => expect(authOf().authStatus).not.toBe('loading'));
    await flows.signIn(authOf, 'first');
    await waitFor(() => expect(view.result.current.offer.eligible).toBe(true));
    const current = view.result.current.offer.current;
    expect(current()).toBe(true);
    let afterBoundary: boolean | undefined;

    // A Begin's answer can land in this gap: the session has ended, nothing
    // has rendered it yet, so only the captured session can tell it is stale.
    act(() => {
      authOf().onUnauthorized();
      afterBoundary = current();
    });
    await waitFor(() => expect(authOf().authStatus).toBe('reauth-required'));

    expect(afterBoundary).toBe(false);
  });
});
