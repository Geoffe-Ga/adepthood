/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { LLM_API_KEY_HEADER, auth as authApi, resonance } from '@/api';
import { ApiKeyProvider, useApiKey } from '@/context/ApiKeyContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import {
  loadDroppedCheckIns,
  loadHabits,
  loadPendingCheckIns,
  recordDroppedCheckIn,
  saveHabits,
  savePendingCheckIn,
} from '@/storage/habitStorage';
import * as llmKeyStorage from '@/storage/llmKeyStorage';
import * as notificationStorage from '@/storage/notificationStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';

/**
 * The account switch that never passes through ``logout``.
 *
 * Its sibling ``ApiKeyLogoutWipe.integration.test.tsx`` drives the door the
 * user closes behind them; this file drives the one they walk straight past —
 * a password reset, or any path that reaches the login screen with the
 * previous user's cache still on disk. The real ``habitStorage`` and the real
 * in-memory AsyncStorage mock are wired up on purpose: the leak is a row on
 * the device, so a test that mocks the storage away can only prove that a
 * function was called.
 */
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
}));

jest.mock('@/storage/llmKeyStorage', () => ({
  loadLlmApiKey: jest.fn(() => Promise.resolve(null)),
  saveLlmApiKey: jest.fn(() => Promise.resolve()),
  clearLlmApiKey: jest.fn(() => Promise.resolve()),
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
const mockNotificationStorage = notificationStorage as jest.Mocked<typeof notificationStorage>;

const USER_A = 1;
const USER_B = 2;

const habitOfUserA: Habit = {
  id: 71,
  stage: 'Beige',
  name: "A's morning sit",
  icon: '🧘',
  streak: 12,
  energy_cost: 2,
  energy_return: 4,
  start_date: new Date('2026-08-01T00:00:00.000Z'),
  goals: [],
  completions: [],
  revealed: true,
};

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
  _resetSerializedWriteForTests();
  // The active scope is module state that outlives a test; a stale one would
  // let a later test read the previous test's namespace.
  setActiveUser(null);
  await AsyncStorage.clear();
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

async function mountSignedOut() {
  const { result } = renderHook(useHarness, { wrapper });
  await waitFor(() => expect(result.current.auth.authStatus).not.toBe('loading'));
  await waitFor(() => expect(result.current.apiKey.isLoading).toBe(false));
  return result;
}

/** Everything a signed-in user accumulates on the device, in one call. */
async function seedDeviceStateForUserA(): Promise<void> {
  await saveHabits([habitOfUserA]);
  await savePendingCheckIn({
    goal_id: 909,
    did_complete: true,
    timestamp: '2026-08-30T10:00:00.000Z',
  });
  await recordDroppedCheckIn({
    goal_id: 908,
    did_complete: true,
    timestamp: '2026-08-29T10:00:00.000Z',
    status: 404,
    dropped_at: '2026-08-29T10:00:05.000Z',
  });
}

describe('an account switch with no explicit logout', () => {
  test('leaves the incoming user none of the previous user’s device state', async () => {
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a', user_id: USER_A })
      .mockResolvedValueOnce({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await seedDeviceStateForUserA();
      await result.current.apiKey.saveApiKey('sk-user-a');
    });
    expect(await loadHabits()).toHaveLength(1);
    expect(await loadPendingCheckIns()).toHaveLength(1);

    // The whole point: no logout() between the two sessions.
    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    expect(await loadHabits()).toBeNull();
    expect(await loadPendingCheckIns()).toEqual([]);
    expect(await loadDroppedCheckIns()).toEqual([]);
    expect(mockLlmStorage.clearLlmApiKey).toHaveBeenCalled();
    expect(mockNotificationStorage.clearAllNotificationData).toHaveBeenCalled();

    await act(async () => {
      await resonance.essay(1);
    });
    expect(lastLlmHeader()).toBeUndefined();
  });

  test('wipes before the incoming session is authenticated, not after', async () => {
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a', user_id: USER_A })
      .mockResolvedValueOnce({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await seedDeviceStateForUserA();
    });

    let habitsVisibleWhenAuthenticated: Habit[] | null = [habitOfUserA];
    await act(async () => {
      const signIn = result.current.auth.login('b@test.com', 'password123');
      await signIn;
      habitsVisibleWhenAuthenticated = await loadHabits();
    });

    expect(result.current.auth.authStatus).toBe('authenticated');
    expect(habitsVisibleWhenAuthenticated).toBeNull();
  });

  test('a password reset that lands on a different account wipes the same way', async () => {
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-a', user_id: USER_A });
    const confirmSpy = jest
      .spyOn(authApi, 'confirmPasswordReset')
      .mockResolvedValue({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await seedDeviceStateForUserA();
    });

    await act(async () => {
      await result.current.auth.confirmPasswordReset('reset-token', 'new-password123');
    });

    expect(await loadHabits()).toBeNull();
    expect(await loadPendingCheckIns()).toEqual([]);
    confirmSpy.mockRestore();
  });
});

describe('re-authenticating as the same user', () => {
  test('keeps that user’s unsent check-in queue, which is real unsaved work', async () => {
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a1', user_id: USER_A })
      .mockResolvedValueOnce({ token: 'token-a2', user_id: USER_A });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await seedDeviceStateForUserA();
    });

    // Ignore the first sign-in's wipe (the device carried no owner stamp);
    // what this test is about is whether the SECOND one wipes.
    mockLlmStorage.clearLlmApiKey.mockClear();
    mockNotificationStorage.clearAllNotificationData.mockClear();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });

    expect(await loadPendingCheckIns()).toHaveLength(1);
    expect(await loadHabits()).toHaveLength(1);
    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(mockNotificationStorage.clearAllNotificationData).not.toHaveBeenCalled();
  });
});

describe('a device whose owner was never recorded', () => {
  test('is wiped on the first sign-in rather than adopted', async () => {
    // The upgrade path: rows written before the device carried an owner stamp
    // belong to nobody the app can name, so handing them to the person signing
    // in would be the same leak by another route.
    await saveHabits([habitOfUserA]);
    mockAuthApi.login.mockResolvedValueOnce({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    expect(await loadHabits()).toBeNull();
  });
});
