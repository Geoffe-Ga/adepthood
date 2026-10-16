/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { fundingOutcome } from '../fundingOutcome';
import ResonanceEssayModal from '../ResonanceEssayModal';
import { usePaymentScope } from '../usePaymentScope';
import { useResonanceExplainer } from '../useResonanceExplainer';

import { auth as authApi, captureSessionToken, refreshSessionToken, resonance } from '@/api';
import type { Marginalia } from '@/api';
import { getAuthSession } from '@/api/sessionToken';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { getActiveUser, getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';

/**
 * #3387, #3409, #3411: Journal payment work across a same-account renewal.
 *
 * ``usePaymentScope`` used to fence on the exact JWT, so a proactive refresh,
 * or a request's own 401-refresh-retry, ended every price, preflight and paid
 * outcome the writer had in flight: a letter spun forever, a tap on "Get
 * Resonance" vanished, and a reading's 402 never opened its refill remedy.
 *
 * Everything here runs through the real ``AuthProvider`` and the real API
 * client; only ``fetch``, the login call and the secure token store are
 * stubbed. A renewal is the client's own rotation (``refreshSessionToken``),
 * and the 401 cases go through the client's own refresh-then-retry. The same
 * account signing back in after a 401, a different account, an A to B to A
 * switch and a sign-out stay refused.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, auth: { ...actual.auth, login: jest.fn() } };
});

jest.mock('@/context/ApiKeyContext', () => ({
  useApiKey: () => ({ apiKey: null, isLoading: false }),
}));

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

jest.mock('@/storage/resonanceExplainerStorage', () => ({
  loadResonanceExplainerDismissed: () => Promise.resolve(false),
  saveResonanceExplainerDismissed: () => Promise.resolve(),
}));

const OWNER = 7;
const OTHER = 8;
const ENTRY = 1;
const NOTE = 4;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_SERVER_ERROR = 500;

const base64Url = (json: object): string =>
  btoa(JSON.stringify(json)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
const tokenFor = (owner: number, session: string): string =>
  `e30.${base64Url({ sub: String(owner), exp: 4_000_000_000, jti: session })}.sig`;

type Reply = { status: number; body: unknown };
type Responder = Reply | Promise<Reply>;

function jsonResponse({ status, body }: Reply): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const USAGE: Reply = {
  status: HTTP_OK,
  body: {
    resonance_route: 'vault_bound',
    monthly_messages_used: 2,
    monthly_messages_remaining: 18,
    monthly_cap: 20,
    monthly_reset_date: '2026-11-01T00:00:00Z',
    offering_balance: 0,
  },
};
const UNAUTHORIZED: Reply = { status: HTTP_UNAUTHORIZED, body: { detail: 'unauthorized' } };
const WALLET_EMPTY: Reply = {
  status: HTTP_PAYMENT_REQUIRED,
  body: { detail: 'insufficient_offerings' },
};

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: NOTE,
    journal_entry_id: ENTRY,
    kind: 'connection',
    anchor_start: 0,
    anchor_end: 6,
    anchor_text: 'willow',
    note: 'It bends.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    ...overrides,
  };
}

const LETTER: Reply = {
  status: HTTP_OK,
  body: {
    ...note({ essay: 'A letter that bends.', essay_generated_at: '2026-10-16T00:00:00Z' }),
    remaining_messages: 17,
    remaining_balance: 0,
    monthly_reset_date: '2026-11-01T00:00:00Z',
  },
};

/**
 * The fake server: each path answers from its own queue, in order, so a test
 * can hold one request open and see exactly which bearer every attempt carried.
 */
const queues = new Map<string, Responder[]>();
let renewals = 0;
let fetchSpy: jest.SpyInstance;

const USAGE_PATH = '/user/usage';
const ESSAY_PATH = `/journal/marginalia/${NOTE}/essay`;
const READING_PATH = `/journal/${ENTRY}/resonance`;
const REFRESH_PATH = '/auth/refresh';

function answer(path: string, ...replies: Responder[]): void {
  queues.set(path, [...(queues.get(path) ?? []), ...replies]);
}

function pathOf(url: string): string {
  const { pathname } = new URL(url);
  return pathname;
}

function route(url: string): Responder {
  const path = pathOf(url);
  if (path === REFRESH_PATH) {
    renewals += 1;
    return {
      status: HTTP_OK,
      body: { token: tokenFor(OWNER, `renewed-${renewals}`), user_id: OWNER, timezone: 'UTC' },
    };
  }
  const queue = queues.get(path) ?? [];
  const next = queue.shift();
  if (next !== undefined) return next;
  return path === USAGE_PATH ? USAGE : { status: 404, body: { detail: 'not_found' } };
}

/** Every attempt at ``path``, as the bearer it carried. */
function bearers(path: string): (string | undefined)[] {
  return fetchSpy.mock.calls
    .filter(([url]) => pathOf(String(url)) === path)
    .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

type Auth = ReturnType<typeof useAuth>;
type AuthOf = () => Auth;

const mockLogin = authApi.login as jest.MockedFunction<typeof authApi.login>;

async function signIn(auth: AuthOf, session: string, owner = OWNER) {
  mockLogin.mockResolvedValueOnce({
    token: tokenFor(owner, session),
    user_id: owner,
    timezone: 'UTC',
  });
  await act(async () => {
    await auth().login(`owner${owner}@test.com`, 'password123');
  });
  expect(auth().authStatus).toBe('authenticated');
  expect(getActiveUser()).toBe(owner);
}

/** The client's own rotation, as the proactive refresh runs it: one session, renewed. */
async function renew(auth: AuthOf) {
  const session = getAuthSession();
  const before = auth().token;
  await act(async () => {
    await refreshSessionToken(captureSessionToken()!);
  });
  await waitFor(() => expect(auth().token).not.toBe(before));
  expect(getAuthSession()).toBe(session);
}

/** A 401 ends the session; the same account signs back in. Nothing about the account moves. */
async function reauthenticateSameOwner(auth: AuthOf) {
  const generation = getActiveUserGeneration();
  const session = getAuthSession();
  act(() => {
    auth().onUnauthorized();
  });
  await waitFor(() => expect(auth().authStatus).toBe('reauth-required'));
  await signIn(auth, 'second');
  expect(getActiveUserGeneration()).toBe(generation);
  expect(getAuthSession()).not.toBe(session);
}

async function signOut(auth: AuthOf) {
  await act(async () => {
    await auth().logout();
  });
  await waitFor(() => expect(auth().authStatus).toBe('anonymous'));
}

/** A to B to A: the account comes back, the generation does not. */
async function switchAwayAndBack(auth: AuthOf) {
  await signOut(auth);
  await signIn(auth, 'other', OTHER);
  await signOut(auth);
  await signIn(auth, 'back');
}

async function mountSignedIn<T>(useHook: () => T) {
  const view = renderHook(() => ({ auth: useAuth(), hook: useHook() }), { wrapper });
  const auth = () => view.result.current.auth;
  await waitFor(() => expect(auth().authStatus).not.toBe('loading'));
  await signIn(auth, 'first');
  return { view, auth, hook: () => view.result.current.hook };
}

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  resetAllStores();
  await AsyncStorage.clear();
  queues.clear();
  renewals = 0;
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) => jsonResponse(await route(String(url))));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('usePaymentScope: one lineage per authenticated session', () => {
  test('a renewal keeps the fence and its identity', async () => {
    const { auth, hook } = await mountSignedIn(() => usePaymentScope());
    const fence = hook();
    expect(fence()).toBe(true);

    await renew(auth);

    expect(fence()).toBe(true);
    expect(hook()).toBe(fence);
  });

  test.each([
    ['the same account signing back in after a 401', reauthenticateSameOwner],
    ['a sign-out', signOut],
    ['an A to B to A switch', switchAwayAndBack],
  ] as const)('%s ends the lineage', async (_label, interrupt) => {
    const { auth, hook } = await mountSignedIn(() => usePaymentScope());
    const fence = hook();

    await interrupt(auth);

    expect(fence()).toBe(false);
  });
});

/** Mount the payer gate beside real auth; ``requestResonance`` is the real reading POST. */
async function mountGate() {
  const requestResonance = jest.fn((apiKey: string | null, route: 'vault_bound' | 'app_provider') =>
    resonance.generate(ENTRY, undefined, apiKey, route).then(
      () => 'completed' as const,
      (error: unknown) => fundingOutcome(error) ?? ('failed' as const),
    ),
  );
  const requestFreeExits = jest.fn(() => Promise.resolve('completed' as const));
  const mounted = await mountSignedIn(() =>
    useResonanceExplainer(requestResonance, requestFreeExits),
  );
  return { ...mounted, requestResonance, requestFreeExits };
}

describe('#3409: a Get Resonance tap whose payer lookup crosses a renewal', () => {
  test('a lookup held across a proactive renewal still opens the disclosure', async () => {
    const { auth, hook, requestResonance } = await mountGate();
    const lookup = deferred<Reply>();
    answer(USAGE_PATH, lookup.promise);
    let tap!: Promise<void>;
    act(() => {
      tap = hook().onPress();
    });
    await waitFor(() => expect(bearers(USAGE_PATH)).toHaveLength(1));
    expect(hook().pending).toBe(true);

    await renew(auth);
    await act(async () => {
      lookup.resolve(USAGE);
      await tap;
    });

    expect(hook().visible).toBe(true);
    expect(hook().continueDisabled).toBe(false);
    expect(hook().pending).toBe(false);
    expect(requestResonance).not.toHaveBeenCalled();
    expect(bearers(READING_PATH)).toHaveLength(0);
  });

  test("a lookup's own 401-refresh-retry still opens the disclosure", async () => {
    const { hook, requestResonance } = await mountGate();
    answer(USAGE_PATH, UNAUTHORIZED, USAGE);

    await act(async () => {
      await hook().onPress();
    });

    const sent = bearers(USAGE_PATH);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(hook().visible).toBe(true);
    expect(hook().pending).toBe(false);
    expect(requestResonance).not.toHaveBeenCalled();
  });

  test('a lookup held across the same account signing back in is dropped, not left pending', async () => {
    const { auth, hook, requestResonance } = await mountGate();
    const lookup = deferred<Reply>();
    answer(USAGE_PATH, lookup.promise);
    let tap!: Promise<void>;
    act(() => {
      tap = hook().onPress();
    });
    await waitFor(() => expect(bearers(USAGE_PATH)).toHaveLength(1));

    await reauthenticateSameOwner(auth);
    await act(async () => {
      lookup.resolve(USAGE);
      await tap;
    });

    expect(hook().visible).toBe(false);
    expect(hook().refillVisible).toBe(false);
    expect(hook().pending).toBe(false);
    expect(requestResonance).not.toHaveBeenCalled();
  });
});

/** Tap, wait for the disclosure, and continue into the real reading POST. */
async function continueIntoReading(hook: () => ReturnType<typeof useResonanceExplainer>) {
  await act(async () => {
    await hook().onPress();
  });
  expect(hook().visible).toBe(true);
  act(() => {
    hook().onContinue();
  });
  await waitFor(() => expect(bearers(READING_PATH).length).toBeGreaterThan(0));
}

describe('#3411: a reading whose 402 arrives after a renewal', () => {
  test('a 401-refresh-retry answered 402 opens the refill remedy', async () => {
    const { hook, requestResonance } = await mountGate();
    answer(READING_PATH, UNAUTHORIZED, WALLET_EMPTY);

    await continueIntoReading(hook);

    await waitFor(() => expect(hook().refillVisible).toBe(true));
    expect(hook().refillReason).toBe('wallet_exhausted');
    expect(hook().visible).toBe(false);
    expect(hook().pending).toBe(false);
    const sent = bearers(READING_PATH);
    // The refused attempt and its one retry: no second reading was asked.
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(requestResonance).toHaveBeenCalledTimes(1);
  });

  test('a reading held across a proactive renewal and answered 402 opens the refill remedy', async () => {
    const { auth, hook, requestResonance } = await mountGate();
    const reading = deferred<Reply>();
    answer(READING_PATH, reading.promise);
    await continueIntoReading(hook);

    await renew(auth);
    await act(async () => {
      reading.resolve(WALLET_EMPTY);
    });

    await waitFor(() => expect(hook().refillVisible).toBe(true));
    expect(bearers(READING_PATH)).toHaveLength(1);
    expect(requestResonance).toHaveBeenCalledTimes(1);
  });

  test('an ordinary 402 with no renewal still opens the refill remedy (control)', async () => {
    const { hook } = await mountGate();
    answer(READING_PATH, WALLET_EMPTY);

    await continueIntoReading(hook);

    await waitFor(() => expect(hook().refillVisible).toBe(true));
    expect(bearers(READING_PATH)).toHaveLength(1);
  });

  test('a 402 held across the same account signing back in never reaches the new session', async () => {
    const { auth, hook } = await mountGate();
    const reading = deferred<Reply>();
    answer(READING_PATH, reading.promise);
    await continueIntoReading(hook);

    await reauthenticateSameOwner(auth);
    await act(async () => {
      reading.resolve(WALLET_EMPTY);
    });

    expect(hook().refillVisible).toBe(false);
    expect(hook().visible).toBe(false);
  });
});

/** The letter modal beside the real auth state, signed in and showing its offer. */
async function mountLetter() {
  const onEssayLoaded = jest.fn();
  const onFundingRequired = jest.fn();
  let auth!: Auth;
  function Probe() {
    auth = useAuth();
    return null;
  }
  const view = render(
    <AuthProvider>
      <Probe />
      <ResonanceEssayModal
        note={note()}
        onClose={jest.fn()}
        onEssayLoaded={onEssayLoaded}
        onFundingRequired={onFundingRequired}
      />
    </AuthProvider>,
  );
  await waitFor(() => expect(auth.authStatus).not.toBe('loading'));
  await signIn(() => auth, 'first');
  const ask = await view.findByTestId('essay-ask');
  return { view, authOf: () => auth, ask, onEssayLoaded, onFundingRequired };
}

describe('#3387: a letter asked for across a renewal', () => {
  test('an offer on screen keeps its price across a renewal instead of rereading it', async () => {
    const { view, authOf } = await mountLetter();
    const reads = bearers(USAGE_PATH).length;

    await renew(authOf);

    expect(bearers(USAGE_PATH)).toHaveLength(reads);
    expect(view.getByTestId('essay-ask')).toBeTruthy();
  });

  test('a letter held across a proactive renewal lands', async () => {
    const { view, authOf, ask, onEssayLoaded } = await mountLetter();
    const letter = deferred<Reply>();
    answer(ESSAY_PATH, letter.promise);
    fireEvent.press(ask);
    await waitFor(() => expect(bearers(ESSAY_PATH)).toHaveLength(1));
    expect(view.getByTestId('essay-loading')).toBeTruthy();

    await renew(authOf);
    await act(async () => {
      letter.resolve(LETTER);
    });

    expect(await view.findByTestId('essay-text')).toHaveTextContent('A letter that bends.');
    expect(view.queryByTestId('essay-loading')).toBeNull();
    expect(onEssayLoaded).toHaveBeenCalledTimes(1);
    expect(bearers(ESSAY_PATH)).toHaveLength(1);
  });

  test("a letter's own 401-refresh-retry lands, asked once more and no further", async () => {
    const { view, authOf, ask, onEssayLoaded } = await mountLetter();
    const first = authOf().token;
    // The retry is held until the renewed credential has rendered, as it would
    // be over a real network round-trip.
    const retried = deferred<Reply>();
    answer(ESSAY_PATH, UNAUTHORIZED, retried.promise);
    fireEvent.press(ask);
    await waitFor(() => expect(bearers(ESSAY_PATH)).toHaveLength(2));
    await waitFor(() => expect(authOf().token).not.toBe(first));

    await act(async () => {
      retried.resolve(LETTER);
    });

    expect(await view.findByTestId('essay-text')).toHaveTextContent('A letter that bends.');
    expect(view.queryByTestId('essay-loading')).toBeNull();
    expect(onEssayLoaded).toHaveBeenCalledTimes(1);
    const sent = bearers(ESSAY_PATH);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });

  test('a failure held across a renewal shows its retry instead of spinning', async () => {
    const { view, authOf, ask, onEssayLoaded } = await mountLetter();
    const letter = deferred<Reply>();
    answer(ESSAY_PATH, letter.promise);
    fireEvent.press(ask);
    await waitFor(() => expect(bearers(ESSAY_PATH)).toHaveLength(1));

    await renew(authOf);
    await act(async () => {
      letter.resolve({ status: HTTP_SERVER_ERROR, body: { detail: 'internal_error' } });
    });

    expect(await view.findByTestId('essay-error')).toBeTruthy();
    expect(view.getByTestId('essay-retry')).toBeTruthy();
    expect(view.queryByTestId('essay-loading')).toBeNull();
    expect(onEssayLoaded).not.toHaveBeenCalled();
  });

  test('a 402 held across a renewal opens the funding remedy instead of spinning', async () => {
    const { view, authOf, ask, onFundingRequired } = await mountLetter();
    const letter = deferred<Reply>();
    answer(ESSAY_PATH, letter.promise);
    fireEvent.press(ask);
    await waitFor(() => expect(bearers(ESSAY_PATH)).toHaveLength(1));

    await renew(authOf);
    await act(async () => {
      letter.resolve(WALLET_EMPTY);
    });

    await waitFor(() => expect(onFundingRequired).toHaveBeenCalledWith('funding_required'));
    expect(onFundingRequired).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('essay-loading')).toBeNull();
    expect(bearers(ESSAY_PATH)).toHaveLength(1);
  });

  test('a letter held across the same account signing back in is refused but not left spinning', async () => {
    const { view, authOf, ask, onEssayLoaded } = await mountLetter();
    const letter = deferred<Reply>();
    answer(ESSAY_PATH, letter.promise);
    fireEvent.press(ask);
    await waitFor(() => expect(bearers(ESSAY_PATH)).toHaveLength(1));

    await reauthenticateSameOwner(authOf);
    await act(async () => {
      letter.resolve(LETTER);
    });

    expect(onEssayLoaded).not.toHaveBeenCalled();
    expect(view.queryByTestId('essay-text')).toBeNull();
    expect(view.queryByTestId('essay-loading')).toBeNull();
    // Back to the offer: asking again is answered from the server's cache, uncharged.
    expect(await view.findByTestId('essay-offer')).toBeTruthy();
  });
});
