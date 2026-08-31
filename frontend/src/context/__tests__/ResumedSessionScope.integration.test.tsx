/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import * as authStorage from '@/storage/authStorage';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { DEVICE_OWNER_KEY, getActiveUser, setActiveUser } from '@/storage/userScope';

/**
 * Which namespace a *resumed* session reads.
 *
 * Its sibling ``AccountSwitchWipe.integration.test.tsx`` drives the sign-in
 * door; this file drives the cold start behind it. It needs its own file
 * because of the token module: the sibling stubs ``decodeJwtPayload`` away,
 * and the invariant here is precisely that the cache namespace comes from the
 * resumed credential rather than from a second value that is only *supposed*
 * to agree with it. So the real decoder runs, against tokens minted in the
 * shape the backend signs — ``sub`` is the stringified user id.
 *
 * A sign-in persists two things, the JWT and the device-owner stamp, and
 * nothing makes those two writes atomic. Each test below tears one of them and
 * then asks the question that matters: can a stamp that outran its token still
 * tell the next person to sign in that they already own this device? That is
 * not merely a stale read — it is the input to the wipe decision, so a
 * divergence cements itself instead of healing.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    auth: { ...actual.auth, login: jest.fn(), refresh: jest.fn() },
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

const mockAuthApi = authApi as jest.Mocked<typeof authApi>;
const mockAuthStorage = authStorage as jest.Mocked<typeof authStorage>;

const USER_A = 1;
const USER_B = 2;
const TOKEN_LIFETIME_SECONDS = 3600;

/** Base64url — the encoding a JWT's payload segment actually uses. */
function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A token shaped like the one ``backend/src/routers/auth.py`` signs: ``sub``
 * is the stringified user id. The signature segment is a placeholder — the
 * client decodes without verifying, and the server is the only party that
 * checks it.
 */
function mintToken(userId: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = { sub: String(userId), exp: issuedAt + TOKEN_LIFETIME_SECONDS, iat: issuedAt };
  return `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${base64Url(JSON.stringify(claims))}.sig`;
}

const tokenOfUserA = mintToken(USER_A);
const tokenOfUserB = mintToken(USER_B);

function habitOf(owner: string): Habit {
  return {
    id: 71,
    stage: 'Beige',
    name: `${owner}'s morning sit`,
    icon: '🧘',
    streak: 12,
    energy_cost: 2,
    energy_return: 4,
    start_date: new Date('2026-08-01T00:00:00.000Z'),
    goals: [],
    completions: [],
    revealed: true,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/**
 * Boot a fresh app process. Resetting the module-level scope is the point: a
 * real cold start has no active user, so a test that inherited the previous
 * mount's scope would pass on leftover state rather than on the code.
 */
async function coldStart(storedToken: string | null) {
  setActiveUser(null);
  mockAuthStorage.loadToken.mockResolvedValue(storedToken);
  const { result, unmount } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.authStatus).not.toBe('loading'));
  return { result, unmount };
}

let restoreSetItem: (() => void) | null = null;

/**
 * Make the next device-owner stamp write reject, and only that one.
 *
 * The swap is a plain property assignment rather than ``jest.spyOn``: a spy's
 * ``mockRestore`` over this module mock leaves behind a bare ``jest.fn`` that
 * silently swallows every later write, which would make the rest of the test
 * pass against a storage layer that no longer stores anything.
 */
function breakNextDeviceOwnerWrite(): void {
  const original = AsyncStorage.setItem;
  const realSetItem = original.bind(AsyncStorage);
  let armed = true;
  restoreSetItem = () => {
    AsyncStorage.setItem = original;
  };
  AsyncStorage.setItem = jest.fn(async (key: string, value: string) => {
    if (armed && key === DEVICE_OWNER_KEY) {
      armed = false;
      throw new Error('storage quota exceeded');
    }
    return realSetItem(key, value);
  });
}

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  await AsyncStorage.clear();
  mockAuthStorage.saveToken.mockResolvedValue(undefined);
  mockAuthStorage.loadToken.mockResolvedValue(null);
  mockAuthStorage.isLogoutPending.mockResolvedValue(false);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
  restoreSetItem?.();
  restoreSetItem = null;
});

describe('a resumed session takes its namespace from the token it resumed', () => {
  test('reads the account the token names, not the account the stamp claims', async () => {
    // A stamp that disagrees with the token on disk is the whole hazard. The
    // token is the credential the server will honour, so it is the authority.
    await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_B));

    const { unmount } = await coldStart(tokenOfUserA);

    expect(getActiveUser()).toBe(USER_A);
    unmount();
  });

  test('a sign-in whose token write is lost cannot leave the next sign-in unwiped', async () => {
    // The device holds A: their stamp and their rows.
    await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_A));
    setActiveUser(USER_A);
    await saveHabits([habitOf('A')]);

    // B signs in, and the app is killed between the two persisted writes, so
    // the JWT never lands — A's token is still what is on disk.
    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOfUserB, user_id: USER_B });
    mockAuthStorage.saveToken.mockRejectedValueOnce(new Error('killed mid-write'));
    const signIn = await coldStart(null);
    await act(async () => {
      await expect(signIn.result.current.login('b@test.com', 'password123')).rejects.toThrow();
    });
    signIn.unmount();

    // Relaunch. A's session resumes and caches its habits, as Today would.
    const resumed = await coldStart(tokenOfUserA);
    expect(resumed.result.current.authStatus).toBe('authenticated');
    await act(async () => {
      await saveHabits([habitOf('A')]);
    });
    resumed.unmount();

    // Now B signs in for real. If A's session wrote into B's namespace, this
    // sign-in reads a stamp that already names B and skips the wipe.
    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOfUserB, user_id: USER_B });
    const second = await coldStart(null);
    await act(async () => {
      await second.result.current.login('b@test.com', 'password123');
    });

    expect(await loadHabits()).toBeNull();
    second.unmount();
  });

  test('a sign-in whose owner stamp write is rejected cannot leave the next sign-in unwiped', async () => {
    // The same tear, opposite half: the token lands and the stamp does not.
    await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_A));
    setActiveUser(USER_A);
    await saveHabits([habitOf('A')]);

    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOfUserB, user_id: USER_B });
    breakNextDeviceOwnerWrite();
    const signIn = await coldStart(null);
    await act(async () => {
      await signIn.result.current.login('b@test.com', 'password123');
    });
    signIn.unmount();

    // Relaunch. B's session resumes and caches B's habits.
    const resumed = await coldStart(tokenOfUserB);
    expect(resumed.result.current.authStatus).toBe('authenticated');
    await act(async () => {
      await saveHabits([habitOf('B')]);
    });
    resumed.unmount();

    // A signs back in. A must not be handed B's cached rows.
    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOfUserA, user_id: USER_A });
    const third = await coldStart(null);
    await act(async () => {
      await third.result.current.login('a@test.com', 'password123');
    });

    expect(await loadHabits()).toBeNull();

    // And B's rows are off the device, not merely out of A's reach. The stamp
    // that lost its write named A, so nothing would have purged B's namespace
    // unless the cold start put the stamp back in step with the resumed token.
    setActiveUser(USER_B);
    expect(await loadHabits()).toBeNull();
    third.unmount();
  });
});

describe('the device-owner stamp', () => {
  test('never names an account whose token failed to land', async () => {
    // The stamp is the input to the next sign-in's wipe decision, so a stamp
    // that runs ahead of its token tells that sign-in the device already
    // belongs to them and there is nothing of anyone else's left to purge.
    await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_A));

    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOfUserB, user_id: USER_B });
    mockAuthStorage.saveToken.mockRejectedValueOnce(new Error('killed mid-write'));
    const { result, unmount } = await coldStart(null);
    await act(async () => {
      await expect(result.current.login('b@test.com', 'password123')).rejects.toThrow();
    });

    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    unmount();
  });
});
