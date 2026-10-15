/* eslint-env jest */
/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import {
  ApiError,
  LLM_API_KEY_HEADER,
  auth as authApi,
  habits as habitsApi,
  resonance,
} from '@/api';
import { ApiKeyProvider, useApiKey } from '@/context/ApiKeyContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { clearUserTimezone, saveUserTimezone } from '@/storage/authStorage';
import { loadCheckInReplayState, saveCheckInReplayState } from '@/storage/checkInReplayState';
import { loadFeedbackDraft, saveFeedbackDraft } from '@/storage/feedbackDraftStorage';
import {
  loadDroppedCheckIns,
  loadHabits,
  loadPendingCheckIns,
  recordDroppedCheckIn,
  saveHabits,
  savePendingCheckIn,
} from '@/storage/habitStorage';
import * as habitStorage from '@/storage/habitStorage';
import * as llmKeyStorage from '@/storage/llmKeyStorage';
import * as notificationStorage from '@/storage/notificationStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

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

jest.mock('@/utils/token', () => ({
  decodeJwtPayload: jest.fn(() => null),
  isTokenExpired: jest.fn(() => false),
  shouldRefreshToken: jest.fn(() => false),
  refreshDeadlineMs: jest.requireActual('@/utils/token').refreshDeadlineMs,
  REFRESH_BUFFER_SECONDS: 300,
}));

const mockAuthApi = authApi as jest.Mocked<typeof authApi>;
const mockLlmStorage = llmKeyStorage as jest.Mocked<typeof llmKeyStorage>;
const mockNotificationStorage = notificationStorage as jest.Mocked<typeof notificationStorage>;
// The cached zone is the one wiped artefact this file mocked without ever
// asserting (#2901). It is also the only one that is NOT namespaced per
// account -- `USER_TIMEZONE_KEY` is written unscoped -- so the per-account
// scoping that backstops every clear above does not backstop this one.
const mockClearUserTimezone = clearUserTimezone as jest.MockedFunction<typeof clearUserTimezone>;
const mockSaveUserTimezone = saveUserTimezone as jest.MockedFunction<typeof saveUserTimezone>;

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

/**
 * A valid essay answer: ``resonance.essay`` is the BYOK-bearing request these
 * tests send, and its answer is schema-checked (note plus balances, #623).
 */
const ESSAY_ANSWER = {
  id: 1,
  journal_entry_id: 1,
  kind: 'theme',
  anchor_start: 0,
  anchor_end: 1,
  anchor_text: 'a',
  note: 'n',
  essay: null,
  essay_generated_at: null,
  status: 'active',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  remaining_messages: 1,
  remaining_balance: 0,
  monthly_reset_date: '2026-10-01T00:00:00Z',
};

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(ESSAY_ANSWER),
  } as unknown as Response;
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
  await saveCheckInReplayState({
    identity: '909|2026-08-30T10:00:00.000Z||true|',
    attempts: 2,
    first_rejected_at: '2026-08-30T10:05:00.000Z',
    last_status: 500,
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
    expect(mockClearUserTimezone).toHaveBeenCalled();

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

  test('drops the outgoing user\u2019s cached zone before the incoming user\u2019s is cached', async () => {
    // Deliberately NOT folded into 'wipes before the incoming session is
    // authenticated': that test pins ordering against observed real-storage
    // state, which works only because `habitStorage` is real here. `authStorage`
    // is fully mocked, so the zone's ordering has to be read off the mocks'
    // invocation order instead. Folding the two would produce a test that looks
    // like it pins this and pins nothing.
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a', user_id: USER_A, timezone: 'America/Denver' })
      .mockResolvedValueOnce({ token: 'token-b', user_id: USER_B, timezone: 'Pacific/Auckland' });
    const result = await mountSignedOut();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    // A device carrying no owner stamp always wipes, so discount the arrival:
    // what this pins is the SECOND sign-in.
    mockClearUserTimezone.mockClear();
    mockSaveUserTimezone.mockClear();

    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    expect(mockClearUserTimezone).toHaveBeenCalled();
    expect(mockSaveUserTimezone).toHaveBeenCalledWith('Pacific/Auckland');
    const [clearedAt = 0] = mockClearUserTimezone.mock.invocationCallOrder;
    const [cachedAt = 0] = mockSaveUserTimezone.mock.invocationCallOrder;
    // The zone lives in a single unscoped device key, so if B's zone were
    // cached first the wipe would take it straight back out again and the next
    // cold start would read A's calendar.
    expect(clearedAt).toBeLessThan(cachedAt);
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

describe('the queue head’s retry record (#2473)', () => {
  test('leaves with the previous user on an account switch', async () => {
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
    expect(await loadCheckInReplayState()).not.toBeNull();

    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    // B's namespace never had it; the point is that A's namespace no longer does.
    expect(await loadCheckInReplayState()).toBeNull();
    setActiveUser(USER_A);
    expect(await loadCheckInReplayState()).toBeNull();
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
    mockClearUserTimezone.mockClear();

    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });

    expect(await loadPendingCheckIns()).toHaveLength(1);
    expect(await loadHabits()).toHaveLength(1);
    // The retry record travels with the queue it describes.
    expect(await loadCheckInReplayState()).not.toBeNull();
    expect(mockLlmStorage.clearLlmApiKey).not.toHaveBeenCalled();
    expect(mockNotificationStorage.clearAllNotificationData).not.toHaveBeenCalled();
    // Without this half the new guard is one-sided: a refactor that wiped on
    // every login, not only on a change of owner, would pass it.
    expect(mockClearUserTimezone).not.toHaveBeenCalled();
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

describe('an account switch with no explicit logout (#2898)', () => {
  test('takes the previous user’s unsent beta report with them', async () => {
    mockAuthApi.login
      .mockResolvedValueOnce({ token: 'token-a', user_id: USER_A })
      .mockResolvedValueOnce({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();
    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await saveFeedbackDraft({
        category: 'confusing',
        impact: 'can_continue',
        answers: { summary: 'A wrote this', intent: '', expected: '', actual: '' },
        idempotencyKey: 'a-key',
        attempt: null,
      });
    });

    await act(async () => {
      await result.current.auth.login('b@test.com', 'password123');
    });

    // B's namespace never had it; the point is that A's namespace no longer does.
    expect(await loadFeedbackDraft()).toBeNull();
    setActiveUser(USER_A);
    expect(await loadFeedbackDraft()).toBeNull();
  });
});

test.each(
  ['adoption', 'logout', 'reauth sign out'].flatMap((kind) => [
    { kind, during: false },
    { kind, during: true },
  ]),
)(
  'an outgoing refresh cannot repopulate the store while $kind awaits a wipe; started during wipe=$during (#3314)',
  async ({ kind, during }) => {
    const tokenFor = (owner: number) =>
      `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
    const tokenModule = jest.requireMock('@/utils/token');
    tokenModule.decodeJwtPayload.mockImplementation(
      jest.requireActual('@/utils/token').decodeJwtPayload,
    );
    mockAuthApi.login.mockReset();
    mockAuthApi.login
      .mockResolvedValueOnce({ token: tokenFor(USER_A), user_id: USER_A })
      .mockResolvedValueOnce({ token: tokenFor(USER_B), user_id: USER_B });
    const result = await mountSignedOut();
    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await seedDeviceStateForUserA();
    useHabitStore.getState().setHabits([habitOfUserA]);
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const list = jest.spyOn(habitsApi, 'listAll').mockImplementationOnce(async () => {
      readStarted();
      await readHeld;
      return [{ ...habitOfUserA, start_date: '2026-08-01' }] as Awaited<
        ReturnType<typeof habitsApi.listAll>
      >;
    });
    let refreshing: Promise<boolean> | undefined;
    if (!during) {
      refreshing = habitManager.refreshHabits('UTC', { replayCheckIns: false });
      await reading;
    }
    let releaseWipe!: () => void;
    const wipeHeld = new Promise<void>((resolve) => {
      releaseWipe = resolve;
    });
    let wipeStarted!: () => void;
    const wiping = new Promise<void>((resolve) => {
      wipeStarted = resolve;
    });
    mockClearUserTimezone.mockImplementationOnce(async () => {
      wipeStarted();
      await wipeHeld;
    });
    let duringWipe: number[] = [];
    await act(async () => {
      const adopting =
        kind === 'adoption'
          ? result.current.auth.login('b@test.com', 'password123')
          : kind === 'logout'
            ? result.current.auth.logout()
            : result.current.auth.dismissReauth();
      await wiping;
      expect(useHabitStore.getState().habits).toEqual([]);
      if (during) {
        refreshing = habitManager.refreshHabits('UTC', { replayCheckIns: false });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      releaseRead();
      await refreshing;
      duringWipe = useHabitStore.getState().habits.map((row) => row.id!);
      releaseWipe();
      await adopting;
    });
    const networkReads = list.mock.calls.length;
    list.mockRestore();
    tokenModule.decodeJwtPayload.mockImplementation(() => null);
    expect({ networkReads, duringWipe }).toEqual({ networkReads: during ? 0 : 1, duringWipe: [] });
    expect(useHabitStore.getState().habits).toEqual([]);
    expect(await loadHabits()).toBeNull();
  },
);

test('new anonymous work cannot rehydrate an unstamped legacy cache during the incoming account wipe (#3314)', async () => {
  const tokenFor = (owner: number) =>
    `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000 }))}.sig`;
  const tokenModule = jest.requireMock('@/utils/token');
  tokenModule.decodeJwtPayload.mockImplementation(
    jest.requireActual('@/utils/token').decodeJwtPayload,
  );
  mockAuthApi.login.mockReset().mockResolvedValueOnce({ token: tokenFor(USER_B), user_id: USER_B });
  const result = await mountSignedOut();
  // A legacy client persisted these rows before device-owner stamps existed.
  // Keep the actual unscoped cache read/write path, with only its clear held.
  await saveHabits([habitOfUserA]);
  useHabitStore.getState().setHabits([habitOfUserA]);
  let releaseClear!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  let clearStarted!: () => void;
  const clearing = new Promise<void>((resolve) => {
    clearStarted = resolve;
  });
  const originalRemove = jest.mocked(AsyncStorage.removeItem).getMockImplementation()!;
  jest.mocked(AsyncStorage.removeItem).mockImplementation(async (key) => {
    if (key === '@adepthood/habits') {
      clearStarted();
      await held;
    }
    await originalRemove(key);
  });
  // An unauthenticated request cannot return A's server rows. The defect is
  // cache hydration before that genuine failure, after the memory reset.
  const list = jest
    .spyOn(habitsApi, 'listAll')
    .mockRejectedValue(new ApiError(401, 'not_authenticated'));
  let duringWipe: number[] = [];
  await act(async () => {
    const adopting = result.current.auth.login('b@test.com', 'password123');
    await clearing;
    expect(useHabitStore.getState().habits).toEqual([]);
    await habitManager.refreshHabits('UTC', { replayCheckIns: false });
    duringWipe = useHabitStore.getState().habits.map((row) => row.id!);
    releaseClear();
    await adopting;
  });
  const networkReads = list.mock.calls.length;
  list.mockRestore();
  jest.mocked(AsyncStorage.removeItem).mockImplementation(originalRemove);
  tokenModule.decodeJwtPayload.mockImplementation(() => null);
  expect({ networkReads, duringWipe }).toEqual({ networkReads: 0, duringWipe: [] });
  expect(useHabitStore.getState().habits).toEqual([]);
  expect(await loadHabits()).toBeNull();
});

/**
 * #3372, mounted: a habit-cache write that A's refresh had already handed to
 * AsyncStorage when the cleanup started must not commit after the wipe's
 * clear. Both doors run the real ``wipeUserState`` against the real
 * ``habitStorage``; only the one in-flight ``setItem`` is held.
 */
describe.each([
  ['logout', (auth: ReturnType<typeof useAuth>) => auth.logout()],
  [
    'a sign-in as another account',
    (auth: ReturnType<typeof useAuth>) => auth.login('b@test.com', 'password123'),
  ],
])('an in-flight habit cache write racing %s (#3372)', (_door, cleanUp) => {
  test('cannot resurrect the outgoing rows once it commits', async () => {
    mockAuthApi.login
      .mockReset()
      .mockResolvedValueOnce({ token: 'token-a', user_id: USER_A })
      .mockResolvedValueOnce({ token: 'token-b', user_id: USER_B });
    const result = await mountSignedOut();
    await act(async () => {
      await result.current.auth.login('a@test.com', 'password123');
    });
    await act(async () => {
      await saveHabits([habitOfUserA]);
    });

    const originalSet = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
    let releaseWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writing = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
      writeStarted();
      await held;
      await originalSet(key, value);
    });

    // The cleanup's clear must be issued while the write is still in flight;
    // only the outgoing account's clear is signalled, the real one still runs.
    const originalClear = habitStorage.clearHabits;
    let markClearIssued!: () => void;
    const clearIssued = new Promise<void>((resolve) => {
      markClearIssued = resolve;
    });
    const clearSpy = jest.spyOn(habitStorage, 'clearHabits').mockImplementation(() => {
      markClearIssued();
      return originalClear();
    });

    await act(async () => {
      const refreshWrite = saveHabits([{ ...habitOfUserA, name: "A's refreshed sit" }]);
      await writing;
      const cleanup = cleanUp(result.current.auth);
      await clearIssued;
      releaseWrite();
      await Promise.all([refreshWrite, cleanup]);
    });
    jest.mocked(AsyncStorage.setItem).mockImplementation(originalSet);
    clearSpy.mockRestore();

    expect(await loadHabits()).toBeNull();
    // Resume A offline: its own namespace must hold nothing the wipe removed.
    setActiveUser(USER_A);
    expect(await loadHabits()).toBeNull();
  });
});
