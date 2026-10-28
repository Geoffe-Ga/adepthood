/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import {
  auth as authApi,
  captureSessionToken,
  goalCompletions,
  habits as habitsApi,
  refreshSessionToken,
} from '@/api';
import type { ApiHabit, CheckInResult } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { loadHabits, loadPendingCheckIns, saveHabits } from '@/storage/habitStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { getActiveUser, getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

/**
 * #3326: an in-place reauthentication by the SAME account.
 *
 * A 401 sends the session to ``'reauth-required'`` without changing the active
 * account, and signing that account back in is a ``setActiveUser`` no-op, so
 * the account generation never moves. A Habit create or log captured by the
 * session that ended must still be treated as stale: its late answer belongs
 * to a session that no longer exists and must not roll back, confirm, or alert
 * over the rows the new session hydrated.
 *
 * Everything on the auth side is the real ``AuthProvider``; only the network
 * edge (``auth.login``, ``habits.*``, ``goalCompletions.create``) and the
 * secure token store are stubbed.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    auth: { ...actual.auth, login: jest.fn(), signup: jest.fn() },
    habits: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), listAll: jest.fn() },
    goalCompletions: { create: jest.fn() },
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

jest.mock('@/features/Habits/hooks/useHabitNotifications', () => ({
  updateHabitNotifications: jest.fn(async () => []),
  cancelForHabit: jest.fn(async () => {}),
}));

const OWNER = 7;
const base64Url = (json: object): string =>
  btoa(JSON.stringify(json)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
const tokenFor = (owner: number, session: string): string =>
  `e30.${base64Url({ sub: String(owner), exp: 4_000_000_000, jti: session })}.sig`;

function deferred<T>() {
  let resolve!: (_value: T) => void;
  let reject!: (_reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function habit(id: number, name: string): Habit {
  return {
    id,
    name,
    stage: 'Beige',
    icon: '🧘',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    revealed: true,
    start_date: new Date('2026-10-01T00:00:00Z'),
    completions: [],
    goals: [
      {
        id: id * 10 + 1,
        title: 'Low',
        tier: 'low',
        target: 1,
        target_unit: 'sessions',
        frequency: 4,
        frequency_unit: 'per_week',
        is_additive: true,
      },
    ],
  };
}

const oldSessionRow = habit(101, 'Before reauthentication');
const newSessionRow = habit(303, 'Hydrated by the new session');

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

const mockLogin = authApi.login as jest.MockedFunction<typeof authApi.login>;

async function signInAgain(result: { current: ReturnType<typeof useAuth> }, session: string) {
  mockLogin.mockResolvedValueOnce({
    token: tokenFor(OWNER, session),
    user_id: OWNER,
    timezone: 'UTC',
  });
  await act(async () => {
    await result.current.login('owner@test.com', 'password123');
  });
  expect(result.current.authStatus).toBe('authenticated');
}

async function mountSignedIn() {
  const { result } = renderHook(useAuth, { wrapper });
  await waitFor(() => expect(result.current.authStatus).not.toBe('loading'));
  await signInAgain(result, 'first');
  await act(async () => {
    useHabitStore.getState().setHabits([oldSessionRow]);
    await saveHabits([oldSessionRow]);
  });
  return result;
}

/** The real in-place reauthentication: a 401 ends the session, the same account signs back in. */
async function reauthenticateSameOwner(result: { current: ReturnType<typeof useAuth> }) {
  const generation = getActiveUserGeneration();
  act(() => {
    result.current.onUnauthorized();
  });
  await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));
  await signInAgain(result, 'second');
  // The gap this file pins: nothing about the account moved.
  expect(getActiveUser()).toBe(OWNER);
  expect(getActiveUserGeneration()).toBe(generation);
  await act(async () => {
    useHabitStore.getState().setHabits([newSessionRow]);
    await saveHabits([newSessionRow]);
  });
}

async function snapshot() {
  return {
    memory: useHabitStore.getState().habits.map((row) => row.id),
    disk: (await loadHabits())?.map((row) => row.id),
  };
}

let alertSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  await AsyncStorage.clear();
  useHabitStore.getState().setHabits([]);
  jest.mocked(habitsApi.update).mockResolvedValue({} as ApiHabit);
  jest.mocked(habitsApi.listAll).mockResolvedValue([]);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
});

describe('a Habit mutation captured before a same-owner reauthentication', () => {
  test.each(['append', 'insert'])(
    'a late %s failure does not roll back or alert over the new session',
    async (kind) => {
      const result = await mountSignedIn();
      const response = deferred<ApiHabit>();
      jest.mocked(habitsApi.create).mockReturnValueOnce(response.promise);
      let saving!: Promise<unknown>;
      act(() => {
        saving =
          kind === 'append'
            ? habitManager.addHabit({ name: 'Held create', icon: '🧘' }, false, 'UTC')
            : habitManager.insertHabitAtWithId({ name: 'Held create', icon: '🧘' }, 1, 'UTC');
      });
      expect(habitsApi.create).toHaveBeenCalledTimes(1);

      await reauthenticateSameOwner(result);
      await act(async () => {
        response.reject(new Error('controlled old-session create failure'));
        await saving;
      });

      expect(await snapshot()).toEqual({ memory: [303], disk: [303] });
      expect(alertSpy).not.toHaveBeenCalled();
    },
  );

  test('a late create success issues no follow-on work and keeps the new session rows', async () => {
    const result = await mountSignedIn();
    const response = deferred<ApiHabit>();
    jest.mocked(habitsApi.create).mockReturnValueOnce(response.promise);
    let saving!: Promise<unknown>;
    act(() => {
      saving = habitManager.insertHabitAtWithId({ name: 'Held create', icon: '🧘' }, 0, 'UTC');
    });

    await reauthenticateSameOwner(result);
    await act(async () => {
      response.resolve({ id: 333 } as ApiHabit);
      await saving;
    });

    expect(habitsApi.update).not.toHaveBeenCalled();
    expect(habitsApi.listAll).not.toHaveBeenCalled();
    expect(habitsApi.delete).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual({ memory: [303], disk: [303] });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('a log prepared by the ended session cannot apply, commit, or roll back', async () => {
    const result = await mountSignedIn();
    const response = deferred<CheckInResult>();
    jest.mocked(goalCompletions.create).mockReturnValueOnce(response.promise);
    const ctx = habitManager.prepareLogUnit(oldSessionRow.id, 1, 'UTC');
    expect(ctx).not.toBeNull();
    let committing!: Promise<CheckInResult | null>;
    act(() => {
      habitManager.applyLogUnitContext(ctx!);
      committing = habitManager.commitLogUnitContext(ctx!);
    });
    await waitFor(() => expect(goalCompletions.create).toHaveBeenCalledTimes(1));

    await reauthenticateSameOwner(result);
    // The reauth entry alone already fences the old log: nothing it captured
    // may write after the session that captured it ended.
    act(() => {
      habitManager.applyLogUnitContext(ctx!);
    });
    expect(useHabitStore.getState().habits.map((row) => row.id)).toEqual([303]);

    let failure: unknown = null;
    await act(async () => {
      response.reject(new Error('controlled old-session log failure'));
      await committing.catch((err: unknown) => {
        failure = err;
      });
      habitManager.rollbackLogUnitContext(ctx!);
    });

    expect(failure).toBeInstanceOf(Error);
    expect(await snapshot()).toEqual({ memory: [303], disk: [303] });
    expect(await loadPendingCheckIns()).toEqual([]);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('stays stale while reauthentication is still pending', async () => {
    const result = await mountSignedIn();
    const ctx = habitManager.prepareLogUnit(oldSessionRow.id, 1, 'UTC');
    expect(ctx).not.toBeNull();
    act(() => {
      result.current.onUnauthorized();
    });
    await waitFor(() => expect(result.current.authStatus).toBe('reauth-required'));

    act(() => {
      habitManager.applyLogUnitContext(ctx!);
    });

    expect(useHabitStore.getState().habits[0]!.completions).toEqual([]);
  });
});

describe('controls: the same uninterrupted session', () => {
  test('a create with no reauthentication still rolls back and explains its failure', async () => {
    await mountSignedIn();
    const response = deferred<ApiHabit>();
    jest.mocked(habitsApi.create).mockReturnValueOnce(response.promise);
    let saving!: Promise<unknown>;
    act(() => {
      saving = habitManager.insertHabitAtWithId({ name: 'Held create', icon: '🧘' }, 1, 'UTC');
    });
    expect(useHabitStore.getState().habits).toHaveLength(2);

    await act(async () => {
      response.reject(new Error('controlled same-session create failure'));
      await saving;
    });

    expect(await snapshot()).toEqual({ memory: [101], disk: [101] });
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  test('a legitimate token refresh keeps the in-flight create in its session', async () => {
    const result = await mountSignedIn();
    const response = deferred<ApiHabit>();
    jest.mocked(habitsApi.create).mockReturnValueOnce(response.promise);
    let saving!: Promise<unknown>;
    act(() => {
      saving = habitManager.insertHabitAtWithId({ name: 'Held create', icon: '🧘' }, 1, 'UTC');
    });
    const renewed = tokenFor(OWNER, 'renewed');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: renewed, user_id: OWNER, timezone: 'UTC' }),
    } as unknown as Response);
    try {
      await act(async () => {
        await refreshSessionToken(captureSessionToken()!);
      });
      await waitFor(() => expect(result.current.token).toBe(renewed));

      await act(async () => {
        response.reject(new Error('controlled renewed-session create failure'));
        await saving;
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(await snapshot()).toEqual({ memory: [101], disk: [101] });
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  test('a log with no reauthentication still applies and rolls back', async () => {
    await mountSignedIn();
    const ctx = habitManager.prepareLogUnit(oldSessionRow.id, 1, 'UTC');
    act(() => {
      habitManager.applyLogUnitContext(ctx!);
    });
    expect(useHabitStore.getState().habits[0]!.completions).toHaveLength(1);

    act(() => {
      habitManager.rollbackLogUnitContext(ctx!);
    });

    expect(useHabitStore.getState().habits[0]!.completions).toEqual([]);
  });
});
