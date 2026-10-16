/**
 * A fake server and the real auth transitions, for suites that prove held
 * work survives a same-account token renewal and dies at every other session
 * boundary (#3452).
 *
 * Suites mount the real ``AuthProvider`` and the real API client; only
 * ``fetch``, ``auth.login`` and the secure token store are stubbed, and those
 * ``jest.mock`` calls stay in the suite (they must be hoisted there). A
 * renewal is the client's own rotation (``refreshSessionToken``); a 401 goes
 * through the client's own refresh-then-retry, which this server answers at
 * ``/auth/refresh`` with a new token for the same owner.
 */
import { expect, jest } from '@jest/globals';
import { act, waitFor } from '@testing-library/react-native';

import { captureSessionToken, refreshSessionToken } from '@/api';
import type { AuthResponse } from '@/api';
import { getAuthSession } from '@/api/sessionToken';
import type { useAuth } from '@/context/AuthContext';
import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';

export const OWNER = 7;
export const OTHER = 8;

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_ERROR_FLOOR = 400;
const FAR_FUTURE_EXP = 4_000_000_000;

export const REFRESH_PATH = '/auth/refresh';

export type Auth = ReturnType<typeof useAuth>;
export type AuthOf = () => Auth;
export type Reply = { status: number; body: unknown };
type Responder = Reply | Promise<Reply>;
/** The suite's mocked ``auth.login``; only its next answer is set here. */
type Login = { mockResolvedValueOnce: (_response: AuthResponse) => unknown };

export const UNAUTHORIZED: Reply = { status: HTTP_UNAUTHORIZED, body: { detail: 'unauthorized' } };

export const ok = (body: unknown): Reply => ({ status: HTTP_OK, body });

const base64Url = (json: object): string =>
  btoa(JSON.stringify(json)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');

/** A decodable JWT for ``owner``; ``session`` keeps every minted token distinct. */
export const tokenFor = (owner: number, session: string): string =>
  `e30.${base64Url({ sub: String(owner), exp: FAR_FUTURE_EXP, jti: session })}.sig`;

export function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function jsonResponse({ status, body }: Reply): Response {
  return {
    ok: status < HTTP_ERROR_FLOOR,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

/**
 * Each path answers from its own queue, in order, then from its fallback, so a
 * suite can hold one request open and see exactly which bearer every attempt
 * carried.
 */
export function createFakeServer(fallbacks: Record<string, Reply> = {}) {
  const queues = new Map<string, Responder[]>();
  let renewals = 0;
  let spy: jest.Spied<typeof fetch> | null = null;

  const route = (url: string): Responder => {
    const path = pathOf(url);
    if (path === REFRESH_PATH) {
      renewals += 1;
      return ok({ token: tokenFor(OWNER, `renewed-${renewals}`), user_id: OWNER, timezone: 'UTC' });
    }
    const next = queues.get(path)?.shift();
    if (next !== undefined) return next;
    return fallbacks[path] ?? { status: HTTP_NOT_FOUND, body: { detail: 'not_found' } };
  };

  return {
    /** Stub ``fetch``; call from ``beforeEach`` after ``jest.restoreAllMocks``. */
    install(): void {
      queues.clear();
      renewals = 0;
      spy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url) => jsonResponse(await route(String(url as string))));
    },
    answer(path: string, ...replies: Responder[]): void {
      queues.set(path, [...(queues.get(path) ?? []), ...replies]);
    },
    /** Every attempt at ``path`` (and method, when given), as the bearer it carried. */
    bearers(path: string, method?: string): (string | undefined)[] {
      return (spy?.mock.calls ?? [])
        .filter(
          ([url, init]) =>
            pathOf(String(url)) === path &&
            (method === undefined || (init?.method ?? 'GET').toUpperCase() === method),
        )
        .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization);
    },
  };
}

export type FakeServer = ReturnType<typeof createFakeServer>;

/** The real auth transitions, driven through ``login`` (a mocked ``auth.login``). */
export function authFlows(mockLogin: Login) {
  async function signIn(auth: AuthOf, session: string, owner = OWNER): Promise<void> {
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
  async function renew(auth: AuthOf): Promise<void> {
    const session = getAuthSession();
    const generation = getActiveUserGeneration();
    const before = auth().token;
    await act(async () => {
      await refreshSessionToken(captureSessionToken()!);
    });
    await waitFor(() => expect(auth().token).not.toBe(before));
    expect(getAuthSession()).toBe(session);
    expect(getActiveUserGeneration()).toBe(generation);
  }

  async function signOut(auth: AuthOf): Promise<void> {
    await act(async () => {
      await auth().logout();
    });
    await waitFor(() => expect(auth().authStatus).toBe('anonymous'));
  }

  /** A 401 ends the session; the same account signs back in. Only the session moves. */
  async function reauthenticateSameOwner(auth: AuthOf): Promise<void> {
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

  return { signIn, renew, signOut, reauthenticateSameOwner, ...accountSwitches(signIn, signOut) };
}

type SignIn = (_auth: AuthOf, _session: string, _owner?: number) => Promise<void>;
type SignOut = (_auth: AuthOf) => Promise<void>;

function accountSwitches(signIn: SignIn, signOut: SignOut) {
  /** A to B: another account holds the device. */
  async function switchAccount(auth: AuthOf): Promise<void> {
    await signOut(auth);
    await signIn(auth, 'other', OTHER);
  }

  /** A to B to A: the account comes back, the generation does not. */
  async function switchAwayAndBack(auth: AuthOf): Promise<void> {
    await switchAccount(auth);
    await signOut(auth);
    await signIn(auth, 'back');
  }

  return { switchAccount, switchAwayAndBack };
}

export type AuthFlows = ReturnType<typeof authFlows>;

type Interrupt = (_auth: AuthOf) => Promise<void>;

/** Every boundary that must still refuse held work, by label. */
export function refusals(flows: AuthFlows): [string, Interrupt][] {
  return [
    ['the same account signing back in after a 401', flows.reauthenticateSameOwner],
    ['a sign-out', flows.signOut],
    ['an account switch', flows.switchAccount],
    ['an A to B to A switch', flows.switchAwayAndBack],
  ];
}
