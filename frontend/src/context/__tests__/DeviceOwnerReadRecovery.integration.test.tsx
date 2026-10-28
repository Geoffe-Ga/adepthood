/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import * as authStorage from '@/storage/authStorage';
import { LEGACY_DECLINE_OWNER_KEY } from '@/storage/declineOwnership';
import { _resetDeviceOwnerStampForTests } from '@/storage/deviceOwnerStamp';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { DEVICE_OWNER_KEY, getActiveUser, setActiveUser } from '@/storage/userScope';
import { loadWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';
import { settle } from '@/testing/asyncSettle';

/**
 * #3367: a failed device-owner READ must not be recorded as unknown provenance.
 *
 * ``preserveLegacyDeclineOwner`` writes its provenance once and never again.
 * Before this fix a rejected ``getItem`` of the owner stamp read as "no owner",
 * so the first sign-in after a disk blip persisted ``owner: null`` for good:
 * the legacy decline choices the stamp's account had made stopped applying to
 * that account forever, although the stamp naming it was intact on disk.
 *
 * A failed lookup now leaves provenance unwritten (and the stamp unreplaced),
 * so the next healthy read records the account that actually owned the legacy
 * rows. #3333's invariant -- the stamp is not replaced until provenance lands
 * -- is what keeps that retry possible.
 *
 * These tests drive the real AuthContext, the real decline-provenance module
 * and the real in-memory AsyncStorage mock, failing only the owner-stamp read.
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

const mockAuthApi = authApi as jest.Mocked<typeof authApi>;
const mockAuthStorage = authStorage as jest.Mocked<typeof authStorage>;

const USER_A = 1;
const USER_B = 2;
const TOKEN_LIFETIME_SECONDS = 3600;
const LEGACY_WRITING_DECLINE_KEY = '@adepthood/writing_habit_offer_answered';

/** Base64url — the encoding a JWT's payload segment actually uses. */
function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A token shaped like the backend's: ``sub`` is the stringified user id. */
function mintToken(userId: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = { sub: String(userId), exp: issuedAt + TOKEN_LIFETIME_SECONDS, iat: issuedAt };
  return `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${base64Url(JSON.stringify(claims))}.sig`;
}

const tokenOf = (userId: number): string => mintToken(userId);

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Mount the provider inside the current process (no restart). */
async function mount(storedToken: string | null = null) {
  mockAuthStorage.loadToken.mockResolvedValue(storedToken);
  const { result, unmount } = renderHook(() => useAuth(), { wrapper });
  await settle();
  expect(result.current.authStatus).not.toBe('loading');
  return { result, unmount };
}

/** Boot a fresh app process: no active scope, no in-memory owner state. */
async function coldStart(storedToken: string | null): Promise<Mounted> {
  setActiveUser(null);
  _resetDeviceOwnerStampForTests();
  return mount(storedToken);
}

async function signIn(app: Mounted, userId: number): Promise<void> {
  mockAuthApi.login.mockResolvedValueOnce({ token: tokenOf(userId), user_id: userId });
  await act(async () => {
    await app.result.current.login(`user${userId}@test.com`, 'password123');
  });
}

let restoreGetItem: (() => void) | null = null;

/**
 * Reject the next ``times`` reads of the owner stamp, then let them through. A
 * property swap rather than ``jest.spyOn``, for the reason ResumedSessionScope
 * gives: a restored spy over this module mock leaves a bare ``jest.fn``.
 */
function rejectOwnerReads(times: number): void {
  let remaining = times;
  const original = AsyncStorage.getItem;
  const realGetItem = original.bind(AsyncStorage);
  restoreGetItem = () => {
    AsyncStorage.getItem = original;
  };
  AsyncStorage.getItem = jest.fn(async (key: string) => {
    if (key === DEVICE_OWNER_KEY && remaining > 0) {
      remaining -= 1;
      throw new Error('disk busy');
    }
    return realGetItem(key);
  });
}

async function storedProvenance(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(LEGACY_DECLINE_OWNER_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** Whether ``userId`` sees the writing-offer decline as answered. */
async function declineAppliesTo(userId: number): Promise<boolean> {
  const previous = getActiveUser();
  setActiveUser(userId);
  try {
    return await loadWritingOfferAnswered();
  } finally {
    setActiveUser(previous);
  }
}

let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  _resetDeviceOwnerStampForTests();
  setActiveUser(null);
  useHabitStore.getState().setHabits([]);
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
  restoreGetItem?.();
  restoreGetItem = null;
});

/** A device A owned before provenance existed, holding A's unscoped decline. */
async function legacyDeviceOwnedByA(): Promise<void> {
  await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_A));
  await AsyncStorage.setItem(LEGACY_WRITING_DECLINE_KEY, 'true');
}

describe('a one-time owner-read failure on same-account adoption', () => {
  test('records nothing, then attributes the legacy choices to their owner on the next healthy read', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(1);
    const app = await mount();

    await signIn(app, USER_A);

    // RED before #3367: { version: 1, owner: null }, written once and forever.
    expect(await storedProvenance()).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));

    await signIn(app, USER_A);

    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(await declineAppliesTo(USER_A)).toBe(true);
    app.unmount();
  });

  test('keeps provenance unwritten through repeated failures, and recovers once reads heal', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(3);
    const app = await mount();

    await signIn(app, USER_A);
    await signIn(app, USER_A);
    await signIn(app, USER_A);

    expect(await storedProvenance()).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));

    await signIn(app, USER_A);

    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(await declineAppliesTo(USER_A)).toBe(true);
    app.unmount();
  });

  test('a restart whose read is healthy recovers the owner', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(1);
    const first = await mount();
    await signIn(first, USER_A);
    first.unmount();

    const resumed = await coldStart(tokenOf(USER_A));

    expect(resumed.result.current.authStatus).toBe('authenticated');
    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(await declineAppliesTo(USER_A)).toBe(true);
    resumed.unmount();
  });

  test('a restart whose read fails again still records nothing', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(2);
    const first = await mount();
    await signIn(first, USER_A);
    first.unmount();

    const resumed = await coldStart(tokenOf(USER_A));

    expect(resumed.result.current.authStatus).toBe('authenticated');
    expect(await storedProvenance()).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    resumed.unmount();
  });
});

describe('legacy choices never cross accounts after a read failure', () => {
  test('A to B: B, signing in during the failure, never inherits A’s choice', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(1);
    const app = await mount();

    await signIn(app, USER_B);
    await signIn(app, USER_B);

    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(getActiveUser()).toBe(USER_B);
    expect(await declineAppliesTo(USER_B)).toBe(false);
    expect(await AsyncStorage.getItem(LEGACY_WRITING_DECLINE_KEY)).toBe('true');
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    app.unmount();
  });

  test('A to B to A: the choice reaches A alone', async () => {
    await legacyDeviceOwnedByA();
    rejectOwnerReads(1);
    const app = await mount();

    await signIn(app, USER_A);
    await signIn(app, USER_B);
    expect(await declineAppliesTo(USER_B)).toBe(false);
    await signIn(app, USER_A);

    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(await declineAppliesTo(USER_A)).toBe(true);
    expect(await declineAppliesTo(USER_B)).toBe(false);
    app.unmount();
  });
});

describe('controls', () => {
  test('a genuinely unstamped device still quarantines its legacy rows as unknown', async () => {
    await AsyncStorage.setItem(LEGACY_WRITING_DECLINE_KEY, 'true');
    const app = await mount();

    await signIn(app, USER_A);

    expect(await storedProvenance()).toEqual({ version: 1, owner: null });
    expect(await declineAppliesTo(USER_A)).toBe(false);
    expect(await AsyncStorage.getItem(LEGACY_WRITING_DECLINE_KEY)).toBe('true');
    app.unmount();
  });

  test('normal adoption with no failure attributes the choices to the stamp’s account', async () => {
    await legacyDeviceOwnedByA();
    const app = await mount();

    await signIn(app, USER_A);

    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    expect(await declineAppliesTo(USER_A)).toBe(true);
    app.unmount();
  });
});
