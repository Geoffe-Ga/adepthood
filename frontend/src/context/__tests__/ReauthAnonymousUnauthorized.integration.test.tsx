/* global test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi, journal, uiFlags } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { clearToken, clearUserTimezone } from '@/storage/authStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';

/**
 * #3396: once a session has expired the app sits in ``reauth-required`` with
 * no token, so every request a still-mounted screen sends goes out anonymous.
 * The first one to 401 (``GET /ui-flags`` in the browser) reports
 * ``not_authenticated``. That 401 says nothing new: the session is already
 * known to be over, and the same person is about to sign back in from the
 * re-auth sheet. It must not collapse the sheet into a full sign-out.
 *
 * The real AuthProvider, real API client and real scope module run here; only
 * the network and the secure-store writes are stubbed.
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

type AuthHook = ReturnType<typeof renderHook<ReturnType<typeof useAuth>, unknown>>['result'];

async function mountAnonymous(): Promise<AuthHook> {
  const { result } = renderHook(useAuth, { wrapper });
  await waitFor(() => expect(result.current.authStatus).toBe('anonymous'));
  return result;
}

async function signIn(result: AuthHook, owner: number, version = 1): Promise<void> {
  mockLogin.mockResolvedValueOnce({
    token: tokenFor(owner, version),
    user_id: owner,
    timezone: 'UTC',
  });
  await act(async () => {
    await result.current.login('person@test.com', 'password123');
  });
  expect(result.current.token).toBe(tokenFor(owner, version));
  expect(result.current.authStatus).toBe('authenticated');
}

/** The session's token is refused and its refresh fails: the re-auth sheet opens. */
async function expireSession(result: AuthHook): Promise<void> {
  fetchSpy
    .mockResolvedValueOnce(jsonResponse({ detail: 'session_expired' }, HTTP_UNAUTHORIZED))
    .mockResolvedValueOnce(jsonResponse({ detail: 'session_expired' }, HTTP_UNAUTHORIZED));
  await act(async () => {
    await journal.update(ENTRY_ID, { message: 'mid-thought' }).catch(() => undefined);
    await flush();
  });
  expect(result.current.token).toBeNull();
  expect(result.current.authStatus).toBe('reauth-required');
}

function authorizationOf(call: number): string | undefined {
  const init = fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

/** A still-mounted screen asks for its UI flags with no token and is refused. */
async function anonymousUiFlags401(): Promise<void> {
  fetchSpy.mockResolvedValueOnce(jsonResponse({ detail: 'not_authenticated' }, HTTP_UNAUTHORIZED));
  const callsBefore = fetchSpy.mock.calls.length;
  await act(async () => {
    await expect(uiFlags.get()).rejects.toMatchObject({ status: HTTP_UNAUTHORIZED });
    await flush();
  });
  expect(authorizationOf(callsBefore)).toBeUndefined();
}

test('an anonymous 401 while reauth-required keeps the re-auth sheet open (#3396)', async () => {
  const result = await mountAnonymous();
  await signIn(result, USER_A);
  await expireSession(result);
  mockClearToken.mockClear();

  await anonymousUiFlags401();

  expect(result.current.authStatus).toBe('reauth-required');
  expect(mockClearToken).not.toHaveBeenCalled();
});

test('signing back in from the sheet after that 401 succeeds without a wipe (#3396)', async () => {
  const result = await mountAnonymous();
  await signIn(result, USER_A);
  await expireSession(result);
  await anonymousUiFlags401();
  mockClearUserTimezone.mockClear();

  await signIn(result, USER_A, 2);

  // Same person: their device-scoped context is kept, not wiped.
  expect(mockClearUserTimezone).not.toHaveBeenCalled();
});

test('control: a genuinely anonymous session still lands on anonymous (#3396)', async () => {
  const result = await mountAnonymous();

  await anonymousUiFlags401();

  expect(result.current.authStatus).toBe('anonymous');
  expect(result.current.token).toBeNull();
});

test('control: dismissing the sheet still signs out after that 401 (#3396)', async () => {
  const result = await mountAnonymous();
  await signIn(result, USER_A);
  await expireSession(result);
  await anonymousUiFlags401();

  await act(async () => {
    await result.current.dismissReauth();
  });

  expect(result.current.authStatus).toBe('anonymous');
  expect(result.current.token).toBeNull();
});

test('control: another account signing in from the sheet still wipes (#3396)', async () => {
  const result = await mountAnonymous();
  await signIn(result, USER_A);
  await expireSession(result);
  await anonymousUiFlags401();
  mockClearUserTimezone.mockClear();

  await signIn(result, USER_B);

  expect(mockClearUserTimezone).toHaveBeenCalled();
});
