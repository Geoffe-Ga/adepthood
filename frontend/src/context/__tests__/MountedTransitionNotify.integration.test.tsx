/**
 * #3368: account cleanup must be observable to the UI that is already mounted.
 *
 * ``wipeUserState`` invalidates the account generation the moment cleanup
 * begins, so async work and taps started under the outgoing account are
 * refused. Before this fix nothing told mounted subscribers: a Settings switch
 * kept showing the outgoing account's stored answer, apparently actionable,
 * while its taps were silently dropped until the final ``setActiveUser``.
 *
 * These specs mount real consumers -- the Settings offer switch over its real
 * device storage, and the Course lifecycle hooks -- under the real
 * ``AuthProvider``, then hold the wipe open on ``clearHabits`` so "cleanup is
 * running" is a state the test can look at.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { auth as authApi } from '@/api';
import type * as ApiModule from '@/api';
import type { AuthResponse } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import {
  useCourseSessionKey,
  useEachCourseSession,
} from '@/features/Course/courseSessionLifecycle';
import { WRITING_OFFER_SWITCH } from '@/features/Settings/journalOfferSwitches';
import { useOfferSwitch } from '@/features/Settings/useOfferSwitch';
import * as habitStorage from '@/storage/habitStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { getActiveUser, getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { saveWritingOfferAnswered } from '@/storage/writingOfferStorage';

jest.mock('@/api', () => {
  const actual = jest.requireActual<typeof ApiModule>('@/api');
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

// Real JWT shapes (``{"sub": "<id>", "exp": 2100-01-01}``), so the Course key
// decodes the credential's owner exactly as it does in the app.
const TOKEN_A = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
const TOKEN_B = 'e30.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
const USER_A = 1;
const USER_B = 2;

const courseStart = jest.fn();
const courseSupersede = jest.fn();

/** The consumers a held wipe must reach, mounted together under the real provider. */
function useMountedConsumers() {
  const auth = useAuth();
  const offerSwitch = useOfferSwitch(WRITING_OFFER_SWITCH);
  const courseKey = useCourseSessionKey();
  useEachCourseSession(courseKey, courseStart, courseSupersede);
  return { auth, offerSwitch, courseKey };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

interface HeldWipe {
  release: () => void;
}

/** Hold the next wipe open on its habit-cache clear until the test releases it. */
function holdNextWipe(): HeldWipe {
  const actual = habitStorage.clearHabits;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(habitStorage, 'clearHabits').mockImplementationOnce(async () => {
    await gate;
    await actual();
  });
  return { release: () => release() };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  });
}

function response(token: string, userId: number): AuthResponse {
  return { token, user_id: userId } as AuthResponse;
}

async function mountSignedIn(token: string, userId: number) {
  mockLogin.mockResolvedValueOnce(response(token, userId));
  const rendered = renderHook(useMountedConsumers, { wrapper });
  await waitFor(() => expect(rendered.result.current.auth.authStatus).toBe('anonymous'));
  await act(async () => {
    await rendered.result.current.auth.login('a@test.com', 'password123');
  });
  await waitFor(() => expect(rendered.result.current.offerSwitch.busy).toBe(false));
  return rendered;
}

async function signIn(
  result: { current: ReturnType<typeof useMountedConsumers> },
  token: string,
  userId: number,
): Promise<void> {
  mockLogin.mockResolvedValueOnce(response(token, userId));
  await act(async () => {
    await result.current.auth.login('x@test.com', 'password123');
  });
  await waitFor(() => expect(result.current.offerSwitch.busy).toBe(false));
}

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  await AsyncStorage.clear();
  // A has declined the end-of-session offer, so A's switch reads "off" and
  // any other namespace reads the default "on".
  setActiveUser(USER_A);
  await saveWritingOfferAnswered(true);
  setActiveUser(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a held logout wipe (A to signed out)', () => {
  it('puts the mounted switch into its unresolved state while cleanup runs', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    expect(result.current.offerSwitch).toMatchObject({ value: false, busy: false });

    const wipe = holdNextWipe();
    let logout: Promise<void> = Promise.resolve();
    act(() => {
      logout = result.current.auth.logout();
    });
    await flush();

    // RED before #3368: { value: false, busy: false } -- A's answer, enabled.
    expect(result.current.offerSwitch.busy).toBe(true);
    // The departing namespace is kept for the clears still running.
    expect(getActiveUser()).toBe(USER_A);

    await act(async () => {
      wipe.release();
      await logout;
    });
    await waitFor(() => expect(result.current.offerSwitch.busy).toBe(false));
    // The final notification landed: the signed-out namespace's own answer.
    expect(result.current.offerSwitch.value).toBe(true);
  });

  it('refuses a tap made mid-cleanup, so nothing is written into the departing namespace', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    const saveSpy = jest.spyOn(AsyncStorage, 'setItem');
    const wipe = holdNextWipe();
    let logout: Promise<void> = Promise.resolve();
    act(() => {
      logout = result.current.auth.logout();
    });
    await flush();
    saveSpy.mockClear();

    act(() => result.current.offerSwitch.set(true));
    await flush();
    expect(saveSpy).not.toHaveBeenCalled();

    await act(async () => {
      wipe.release();
      await logout;
    });
  });

  it('does not start a second Course lifecycle for the outgoing account mid-cleanup', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    expect(courseStart).toHaveBeenCalledTimes(2); // initial mount + A's session
    const wipe = holdNextWipe();
    let logout: Promise<void> = Promise.resolve();
    act(() => {
      logout = result.current.auth.logout();
    });
    await flush();

    // The token is still A's while the wipe runs; a notification alone would
    // otherwise mint a fresh "A at the cleanup generation" lifecycle.
    expect(result.current.courseKey).toBeNull();
    expect(courseStart).toHaveBeenCalledTimes(2);

    await act(async () => {
      wipe.release();
      await logout;
    });
    expect(courseStart).toHaveBeenCalledTimes(2);
    expect(result.current.courseKey).toBeNull();
  });
});

describe('a held account-switch wipe (A to B)', () => {
  it('shows neither account’s answer mid-cleanup, then B’s own once B is adopted', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    const startsBefore = courseStart.mock.calls.length;
    const wipe = holdNextWipe();
    mockLogin.mockResolvedValueOnce(response(TOKEN_B, USER_B));
    let signInB: Promise<void> = Promise.resolve();
    act(() => {
      signInB = result.current.auth.login('b@test.com', 'password123');
    });
    await flush();

    expect(result.current.offerSwitch.busy).toBe(true);
    // No premature adoption: the clears still target A's namespace.
    expect(getActiveUser()).toBe(USER_A);
    expect(result.current.courseKey).toBeNull();
    expect(courseStart).toHaveBeenCalledTimes(startsBefore);

    await act(async () => {
      wipe.release();
      await signInB;
    });
    await waitFor(() => expect(result.current.offerSwitch.busy).toBe(false));
    expect(result.current.offerSwitch.value).toBe(true);
    expect(result.current.courseKey).toBe(`${USER_B}:${getActiveUserGeneration()}`);
    // Exactly one new lifecycle, for B.
    expect(courseStart).toHaveBeenCalledTimes(startsBefore + 1);
  });

  it('A to B to A: each arrival gets one lifecycle and its own answer back', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    const startsBefore = courseStart.mock.calls.length;

    await signIn(result, TOKEN_B, USER_B);
    expect(result.current.offerSwitch.value).toBe(true);
    await signIn(result, TOKEN_A, USER_A);

    expect(result.current.offerSwitch).toMatchObject({ value: false, busy: false });
    expect(result.current.courseKey).toBe(`${USER_A}:${getActiveUserGeneration()}`);
    expect(courseStart).toHaveBeenCalledTimes(startsBefore + 2);
  });
});

describe('the same account signing in again (no change of owner)', () => {
  it('runs no cleanup, notifies nobody and keeps the mounted answer', async () => {
    const { result } = await mountSignedIn(TOKEN_A, USER_A);
    const startsBefore = courseStart.mock.calls.length;
    const generation = getActiveUserGeneration();
    const busyStates: boolean[] = [];
    const clearSpy = jest.spyOn(habitStorage, 'clearHabits');

    mockLogin.mockResolvedValueOnce(response(TOKEN_A, USER_A));
    await act(async () => {
      const again = result.current.auth.login('a@test.com', 'password123');
      busyStates.push(result.current.offerSwitch.busy);
      await again;
    });
    busyStates.push(result.current.offerSwitch.busy);

    expect(clearSpy).not.toHaveBeenCalled();
    expect(getActiveUserGeneration()).toBe(generation);
    expect(busyStates).toEqual([false, false]);
    expect(result.current.offerSwitch).toMatchObject({ value: false, busy: false });
    expect(courseStart).toHaveBeenCalledTimes(startsBefore);
  });
});
