/* global test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi, journal } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { clearToken, clearUserTimezone } from '@/storage/authStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';

/**
 * #3366: while an account wipe is awaited, ``captureSessionToken`` answers
 * ``undefined`` for everyone, so an unrelated still-mounted journal autosave
 * that uses the default getter goes out anonymously. That anonymity is
 * synthetic — the transition made it — so its 401 says nothing about any
 * session, and it must never reach the global unauthorized callback, whose
 * slow teardown would otherwise land on top of the incoming account.
 *
 * The real AuthProvider, real API client and real scope module run here; only
 * the network and the secure-store writes are stubbed, so the race is the one
 * the app can actually lose.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, auth: { ...actual.auth, login: jest.fn(), refresh: jest.fn() } };
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

jest.mock('@/storage/llmKeyStorage', () => ({
  loadLlmApiKey: jest.fn(() => Promise.resolve(null)),
  saveLlmApiKey: jest.fn(() => Promise.resolve()),
  clearLlmApiKey: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/storage/notificationStorage', () => ({
  clearAllNotificationData: jest.fn(() => Promise.resolve()),
}));

const mockLogin = authApi.login as jest.MockedFunction<typeof authApi.login>;
const mockClearToken = clearToken as jest.MockedFunction<typeof clearToken>;
const mockClearUserTimezone = clearUserTimezone as jest.MockedFunction<typeof clearUserTimezone>;

const USER_A = 1;
const USER_B = 2;
const ENTRY_ID = 77;
const HTTP_UNAUTHORIZED = 401;

const tokenFor = (owner: number, version = 1) =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000, jti: String(version) })).replace(/=+$/u, '')}.sig`;

function jsonResponse(body: unknown, status: number): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Held<T> {
  promise: Promise<T>;
  resolve: (_value: T) => void;
}

function hold<T>(): Held<T> {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  await AsyncStorage.clear();
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function signIn(owners: number[]) {
  mockLogin.mockReset();
  owners.forEach((owner) =>
    mockLogin.mockResolvedValueOnce({ token: tokenFor(owner), user_id: owner, timezone: 'UTC' }),
  );
  const { result } = renderHook(useAuth, { wrapper });
  await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));
  await act(async () => {
    await result.current.login('first@test.com', 'password123');
  });
  expect(result.current.token).toBe(tokenFor(owners[0]!));
  return result;
}

function authorizationOf(call: number): string | undefined {
  const init = fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

/**
 * Sign in as ``incoming`` with the outgoing account's wipe held; dispatch a
 * default-token journal autosave inside it and land its 401 there too, with
 * the secure-store delete slow enough to outlive the adoption.
 */
async function adoptAcrossAnonymousFailure(
  result: Awaited<ReturnType<typeof signIn>>,
  incoming: number,
) {
  const wipe = hold<void>();
  const wipeStarted = hold<void>();
  mockClearUserTimezone.mockImplementationOnce(async () => {
    wipeStarted.resolve();
    await wipe.promise;
  });
  const slowDelete = hold<void>();
  mockClearToken.mockImplementationOnce(() => slowDelete.promise);
  const network = hold<Response>();
  fetchSpy.mockImplementationOnce(() => network.promise);
  const callsBefore = fetchSpy.mock.calls.length;
  let autosave: Promise<unknown> | undefined;
  await act(async () => {
    const adopting = result.current.login('next@test.com', 'password123');
    await wipeStarted.promise;
    autosave = journal.update(ENTRY_ID, { message: 'still typing' }).catch((err: unknown) => err);
    await flush();
    network.resolve(jsonResponse({ detail: 'not_authenticated' }, HTTP_UNAUTHORIZED));
    await autosave;
    wipe.resolve();
    await adopting;
    slowDelete.resolve();
    await flush();
  });
  expect(authorizationOf(callsBefore)).toBeUndefined();
  await expect(autosave).resolves.toMatchObject({ status: HTTP_UNAUTHORIZED });
  expect(result.current.token).toBe(tokenFor(incoming));
  expect(result.current.authStatus).toBe('authenticated');
}

test.each([
  { name: 'A→B', owners: [USER_A, USER_B] },
  { name: 'A→B→A', owners: [USER_A, USER_B, USER_A] },
])(
  'a transition-time anonymous 401 cannot clear the incoming session: $name (#3366)',
  async ({ owners }) => {
    const result = await signIn(owners);
    for (const incoming of owners.slice(1)) {
      mockClearToken.mockClear();
      await adoptAcrossAnonymousFailure(result, incoming);
      expect(mockClearToken).not.toHaveBeenCalled();
    }
  },
);

test('control: a legitimate current-session 401 still ends that session (#3366)', async () => {
  const result = await signIn([USER_A, USER_B]);
  await adoptAcrossAnonymousFailure(result, USER_B);
  fetchSpy
    .mockResolvedValueOnce(jsonResponse({ detail: 'session_expired' }, HTTP_UNAUTHORIZED))
    .mockResolvedValueOnce(jsonResponse({ detail: 'session_expired' }, HTTP_UNAUTHORIZED));
  const callsBefore = fetchSpy.mock.calls.length;
  await act(async () => {
    await journal.update(ENTRY_ID, { message: 'later' }).catch(() => undefined);
    await flush();
  });
  expect(authorizationOf(callsBefore)).toBe(`Bearer ${tokenFor(USER_B)}`);
  expect(mockClearToken).toHaveBeenCalledTimes(1);
  expect(result.current.token).toBeNull();
  expect(result.current.authStatus).toBe('reauth-required');
});

test('control: same-owner renewal keeps the session through a current-session 401 (#3366)', async () => {
  const result = await signIn([USER_A, USER_A]);
  // The first sign-in on an unstamped device wipes; only the renewal is under test.
  mockClearUserTimezone.mockClear();
  await act(async () => {
    await result.current.login('again@test.com', 'password123');
  });
  const renewed = tokenFor(USER_A, 2);
  fetchSpy
    .mockResolvedValueOnce(jsonResponse({ detail: 'session_expired' }, HTTP_UNAUTHORIZED))
    .mockResolvedValueOnce(jsonResponse({ token: renewed, user_id: USER_A, timezone: 'UTC' }, 200))
    .mockResolvedValueOnce(jsonResponse({ detail: 'gone' }, 404));
  await act(async () => {
    await journal.update(ENTRY_ID, { message: 'renewed' }).catch(() => undefined);
    await flush();
  });
  expect(mockClearUserTimezone).not.toHaveBeenCalled();
  expect(mockClearToken).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.token).toBe(renewed));
  expect(result.current.authStatus).toBe('authenticated');
});
