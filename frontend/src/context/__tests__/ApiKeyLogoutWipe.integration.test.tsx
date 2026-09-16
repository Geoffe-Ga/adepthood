/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { LLM_API_KEY_HEADER, auth as authApi, resonance } from '@/api';
import { ApiKeyProvider, useApiKey } from '@/context/ApiKeyContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { clearUserTimezone } from '@/storage/authStorage';
import { clearDroppedCheckIns, clearHabits, clearPendingCheckIns } from '@/storage/habitStorage';
import * as llmKeyStorage from '@/storage/llmKeyStorage';
import { clearAllNotificationData } from '@/storage/notificationStorage';
import { setActiveUser } from '@/storage/userScope';

// Reproduces the BYOK leak end-to-end: mount the real AuthProvider +
// ApiKeyProvider trio wired exactly as App.tsx does, keep the real API-layer
// reset seam (setLlmApiKeyGetter / setLlmApiKeyReset / resetLlmApiKey /
// resonance), and only stub the network boundary (auth.login/signup/refresh)
// and device storage.
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    auth: {
      ...actual.auth,
      login: jest.fn(),
      signup: jest.fn(),
      refresh: jest.fn(),
    },
  };
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

jest.mock('@/storage/habitStorage', () => ({
  clearHabits: jest.fn(() => Promise.resolve()),
  clearPendingCheckIns: jest.fn(() => Promise.resolve()),
  clearDroppedCheckIns: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/storage/notificationStorage', () => ({
  clearAllNotificationData: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/utils/token', () => ({
  decodeJwtPayload: jest.fn(() => null),
  isTokenExpired: jest.fn(() => false),
  shouldRefreshToken: jest.fn(() => false),
  REFRESH_BUFFER_SECONDS: 300,
}));

const mockAuthApi = authApi as jest.Mocked<typeof authApi>;
const mockLlmStorage = llmKeyStorage as jest.Mocked<typeof llmKeyStorage>;
// Four of this file's six wipe targets were mocked and never asserted (#2901).
// A mock with no expectation is indistinguishable from an absent clear, which
// is exactly the shape these suites exist to rule out, so all four are held
// below rather than only the cached zone the ticket named.
const mockClearUserTimezone = clearUserTimezone as jest.MockedFunction<typeof clearUserTimezone>;
const mockClearHabits = clearHabits as jest.MockedFunction<typeof clearHabits>;
const mockClearPendingCheckIns = clearPendingCheckIns as jest.MockedFunction<
  typeof clearPendingCheckIns
>;
const mockClearAllNotificationData = clearAllNotificationData as jest.MockedFunction<
  typeof clearAllNotificationData
>;

function okResponse(): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ApiKeyProvider>{children}</ApiKeyProvider>
    </AuthProvider>
  );
}

function useHarness() {
  return { auth: useAuth(), apiKey: useApiKey() };
}

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  // The device-owner stamp and the active scope are both module-level state
  // that outlives a test; leaving either in place would make one test's
  // sign-in look like a returning user to the next.
  await AsyncStorage.clear();
  setActiveUser(null);
  mockLlmStorage.loadLlmApiKey.mockResolvedValue(null);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(okResponse()));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function lastLlmHeader(): string | undefined {
  const call = fetchSpy.mock.calls.at(-1) as [string, RequestInit | undefined] | undefined;
  const init = call?.[1];
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[LLM_API_KEY_HEADER];
}

describe('BYOK key does not leak across a logout on a shared device', () => {
  test('logout wipes the key so the next resonance request carries no header', async () => {
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-a', user_id: 1 });
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
    await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await result.current.apiKey.saveApiKey('sk-user-a');
    });

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBe('sk-user-a');

    await act(async () => {
      await result.current.auth.logout();
    });

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBeUndefined();
    expect(mockLlmStorage.clearLlmApiKey).toHaveBeenCalled();
    expect(mockClearUserTimezone).toHaveBeenCalled();
    expect(mockClearHabits).toHaveBeenCalled();
    expect(mockClearPendingCheckIns).toHaveBeenCalled();
    expect(mockClearAllNotificationData).toHaveBeenCalled();
  });

  test('dismissReauth wipes the key', async () => {
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-a', user_id: 1 });
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
    await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await result.current.apiKey.saveApiKey('sk-user-a');
    });

    await act(async () => {
      result.current.auth.onUnauthorized();
    });
    await waitFor(() => expect(result.current.auth.authStatus).toBe('reauth-required'));

    await act(async () => {
      await result.current.auth.dismissReauth();
    });

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBeUndefined();
    // The second tear-down door. It reaches the same wipe through
    // `tearDownSession`, and until now exercised it for no target at all.
    expect(mockClearUserTimezone).toHaveBeenCalled();
  });

  test('a forced reauth alone (no dismiss) retains the key by design', async () => {
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-a', user_id: 1 });
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
    await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await result.current.apiKey.saveApiKey('sk-user-a');
    });

    await act(async () => {
      result.current.auth.onUnauthorized();
    });
    await waitFor(() => expect(result.current.auth.authStatus).toBe('reauth-required'));

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBe('sk-user-a');
  });

  /**
   * This test used to insert a ``logout()`` between the two sessions — the one
   * step that made it pass — while claiming the general invariant in its name.
   * The logout door has its own coverage above; this one drives the claim as
   * written, with nothing between user A's key and user B's session.
   */
  test('the next user on the device never inherits the prior key', async () => {
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a', user_id: 1 })
      .mockResolvedValueOnce({ token: 'token-b', user_id: 2 });
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
    await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await result.current.apiKey.saveApiKey('sk-user-a');
    });

    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBeUndefined();

    await act(async () => {
      await result.current.apiKey.saveApiKey('sk-user-b');
    });
    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBe('sk-user-b');
    expect(lastLlmHeader()).not.toBe('sk-user-a');
  });
});

describe('the dropped-check-in quarantine does not survive a logout on a shared device', () => {
  async function signIn() {
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-a', user_id: 1 });
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
    await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));
    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    // Signing in on a device whose recorded owner is not this user wipes too;
    // these tests are about the logout door, so discount the arrival.
    (clearDroppedCheckIns as jest.Mock).mockClear();
    return result;
  }

  test('logout clears the quarantine', async () => {
    const result = await signIn();

    await act(async () => {
      await result.current.auth.logout();
    });

    expect(clearDroppedCheckIns).toHaveBeenCalledTimes(1);
  });

  test('dismissing the re-auth sheet clears the quarantine', async () => {
    const result = await signIn();

    await act(async () => {
      result.current.auth.onUnauthorized();
    });
    await waitFor(() => expect(result.current.auth.authStatus).toBe('reauth-required'));

    await act(async () => {
      await result.current.auth.dismissReauth();
    });

    expect(clearDroppedCheckIns).toHaveBeenCalledTimes(1);
  });

  test('a forced reauth alone leaves the quarantine intact', async () => {
    const result = await signIn();

    await act(async () => {
      result.current.auth.onUnauthorized();
    });
    await waitFor(() => expect(result.current.auth.authStatus).toBe('reauth-required'));

    expect(clearDroppedCheckIns).not.toHaveBeenCalled();
  });
});
