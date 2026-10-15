/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import * as authStorage from '@/storage/authStorage';
import { LEGACY_DECLINE_OWNER_KEY } from '@/storage/declineOwnership';
import { _resetDeviceOwnerStampForTests } from '@/storage/deviceOwnerStamp';
import { loadHabits, saveHabits } from '@/storage/habitStorage';
import * as llmKeyStorage from '@/storage/llmKeyStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { DEVICE_OWNER_KEY, getActiveUser, setActiveUser } from '@/storage/userScope';
import { loadWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';
import { settle } from '@/testing/asyncSettle';

/**
 * #3333: the device-owner stamp after a provenance write that did not land.
 *
 * A sign-in records legacy decline provenance before it may replace the
 * stamp, and skips the stamp when that write rejects. The session itself is
 * fine — it takes its namespace from its own credential — but the stamp still
 * names the previous account, and the stamp is what the NEXT sign-in compares
 * against. Left alone, the same person signing back in reads as an account
 * replacement and ``wipeUserState`` deletes their BYOK key and resets their
 * in-memory stores.
 *
 * These tests drive the real AuthContext, the real decline-provenance module
 * and the real in-memory AsyncStorage mock, failing only the provenance write.
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
const mockLlmStorage = llmKeyStorage as jest.Mocked<typeof llmKeyStorage>;

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

let restoreSetItem: (() => void) | null = null;

/**
 * Route provenance writes through ``fault``. A plain property swap rather than
 * ``jest.spyOn``, for the reason ResumedSessionScope gives: a restored spy
 * over this module mock leaves a bare ``jest.fn`` that stores nothing.
 */
function interceptProvenanceWrites(fault: () => Promise<void>): void {
  const original = AsyncStorage.setItem;
  const realSetItem = original.bind(AsyncStorage);
  restoreSetItem = () => {
    AsyncStorage.setItem = original;
  };
  AsyncStorage.setItem = jest.fn(async (key: string, value: string) => {
    if (key === LEGACY_DECLINE_OWNER_KEY) await fault();
    return realSetItem(key, value);
  });
}

/** Reject the next ``times`` provenance writes, then let them land. */
function rejectProvenanceWrites(times: number): void {
  let remaining = times;
  interceptProvenanceWrites(async () => {
    if (remaining <= 0) return;
    remaining -= 1;
    throw new Error('storage quota exceeded');
  });
}

/** Everything a signed-in owner keeps live: a cached row and an in-memory store. */
async function seedLiveState(owner: string): Promise<void> {
  await act(async () => {
    await saveHabits([habitOf(owner)]);
    useHabitStore.getState().setHabits([habitOf(owner)]);
  });
}

async function storedProvenance(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(LEGACY_DECLINE_OWNER_KEY);
  return raw === null ? null : JSON.parse(raw);
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
  restoreSetItem?.();
  restoreSetItem = null;
});

/** A device A owned before provenance existed, with nothing recorded yet. */
async function deviceOwnedByA(): Promise<void> {
  await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(USER_A));
}

describe('same-account re-authentication after a failed provenance write', () => {
  test('keeps the BYOK key and live stores, and recovers the stamp', async () => {
    await deviceOwnedByA();
    rejectProvenanceWrites(1);
    const app = await mount();
    await signIn(app, USER_B);
    // The invariant this issue must keep: no provenance, no stamp replacement.
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(app, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(await loadHabits()).toHaveLength(1);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    // Provenance names the account that owned the legacy rows, not B.
    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    app.unmount();
  });

  test('keeps the same owner through repeated provenance failures', async () => {
    await deviceOwnedByA();
    rejectProvenanceWrites(Number.POSITIVE_INFINITY);
    const app = await mount();
    await signIn(app, USER_B);
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(app, USER_B);
    await signIn(app, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toHaveLength(1);
    // Still no provenance, so the stamp is still not replaced.
    expect(await storedProvenance()).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    app.unmount();
  });

  test('survives a held provenance write that eventually rejects', async () => {
    await deviceOwnedByA();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    interceptProvenanceWrites(async () => {
      calls += 1;
      if (calls > 1) return;
      await held;
      throw new Error('storage quota exceeded');
    });
    const app = await mount();
    mockAuthApi.login.mockResolvedValueOnce({ token: tokenOf(USER_B), user_id: USER_B });
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = app.result.current.login('b@test.com', 'password123');
      await Promise.resolve();
    });
    expect(mockAuthStorage.saveToken).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await pending;
    });
    expect(app.result.current.authStatus).toBe('authenticated');
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(app, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    app.unmount();
  });
});

describe('account changes after a failed provenance write still wipe the outgoing owner', () => {
  test('A→B→A wipes B, the account actually leaving', async () => {
    await deviceOwnedByA();
    rejectProvenanceWrites(1);
    const app = await mount();
    await signIn(app, USER_B);
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(app, USER_A);

    expect(mockLlmStorage.clearLlmApiKey).toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toEqual([]);
    setActiveUser(USER_B);
    expect(await loadHabits()).toBeNull();
    setActiveUser(USER_A);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    app.unmount();
  });

  test('A→B with a failed write, then a third account, wipes B', async () => {
    const USER_C = 3;
    await deviceOwnedByA();
    rejectProvenanceWrites(1);
    const app = await mount();
    await signIn(app, USER_B);
    await seedLiveState('B');

    await signIn(app, USER_C);

    setActiveUser(USER_B);
    expect(await loadHabits()).toBeNull();
    setActiveUser(USER_C);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_C));
    app.unmount();
  });

  test('normal A→B adoption with no failure wipes A and stamps B', async () => {
    await deviceOwnedByA();
    setActiveUser(USER_A);
    await saveHabits([habitOf('A')]);
    setActiveUser(null);
    const app = await mount();
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(app, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).toHaveBeenCalled();
    setActiveUser(USER_A);
    expect(await loadHabits()).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    app.unmount();
  });
});

describe('unknown provenance stays unassigned through recovery', () => {
  test('an unstamped device records no owner when the retry lands', async () => {
    rejectProvenanceWrites(1);
    await AsyncStorage.setItem(LEGACY_WRITING_DECLINE_KEY, 'true');
    const app = await mount();
    await signIn(app, USER_B);

    await signIn(app, USER_B);

    expect(await storedProvenance()).toEqual({ version: 1, owner: null });
    expect(getActiveUser()).toBe(USER_B);
    expect(await loadWritingOfferAnswered()).toBe(false);
    expect(await AsyncStorage.getItem(LEGACY_WRITING_DECLINE_KEY)).toBe('true');
    app.unmount();
  });
});

describe('restart after a failed provenance write', () => {
  test('a cold start that retries successfully recovers the stamp', async () => {
    await deviceOwnedByA();
    rejectProvenanceWrites(1);
    const first = await mount();
    await signIn(first, USER_B);
    first.unmount();

    const resumed = await coldStart(tokenOf(USER_B));
    expect(resumed.result.current.authStatus).toBe('authenticated');
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(resumed, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    expect(await storedProvenance()).toEqual({ version: 1, owner: USER_A });
    resumed.unmount();
  });

  test('a cold start whose retry fails again still treats the resumed account as owner', async () => {
    await deviceOwnedByA();
    rejectProvenanceWrites(2);
    const first = await mount();
    await signIn(first, USER_B);
    first.unmount();

    const resumed = await coldStart(tokenOf(USER_B));
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    await seedLiveState('B');
    mockLlmStorage.clearLlmApiKey.mockClear();

    await signIn(resumed, USER_B);

    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(useHabitStore.getState().habits).toHaveLength(1);
    expect(await AsyncStorage.getItem(DEVICE_OWNER_KEY)).toBe(String(USER_B));
    resumed.unmount();
  });
});
