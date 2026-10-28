/* global describe, test, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import {
  auth as authApi,
  captureSessionToken,
  corpusConsent,
  course,
  depthPreferences,
  goals,
  habits as habitsApi,
  refreshSessionToken,
  userPractices,
} from '@/api';
import type { CorpusConsent, DepthPreferences, SiteResource, UserPractice } from '@/api';
import { getAuthSession } from '@/api/sessionToken';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { captureCourseSession, type CourseSession } from '@/features/Course/courseSession';
import { useStartHereStore } from '@/features/Course/startHereStore';
import { useEnergyScaffoldingHandoff } from '@/features/Course/useEnergyScaffoldingHandoff';
import type { Habit } from '@/features/Habits/Habits.types';
import { useEnergyOnboardingIntent } from '@/features/Habits/hooks/useEnergyOnboardingIntent';
import { habitSyncScopeKey } from '@/features/Habits/services/habitSyncScope';
import {
  JOURNAL_HABIT_DEFAULT_GOALS,
  writingGoalDraft,
} from '@/features/Journal/journalHabitDefaults';
import { saveWritingHabitGoals } from '@/features/Journal/writingHabitGoals';
import { usePracticeHabitLink } from '@/features/Practice/hooks/usePracticeHabitLink';
import { useCorpusConsent } from '@/features/Settings/useCorpusConsent';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { getActiveUser, getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';
import { useHabitStore } from '@/store/useHabitStore';

/**
 * #3423: the scopes #3404 left on the account generation alone.
 *
 * A 401 keeps the active account and the same account signing back in is a
 * ``setActiveUser`` no-op, so the generation never moves. Work captured by the
 * session that ended (a Course read, a writing-goal save, a practice habit
 * link, a corpus-consent decision, a Course-to-Habits Energy handoff) must not
 * land in the session that replaced it. A legitimate token refresh is the same
 * session renewed and must keep its in-flight work.
 *
 * The auth side is the real ``AuthProvider``; only the network edge and the
 * secure token store are stubbed.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    auth: { ...actual.auth, login: jest.fn(), signup: jest.fn() },
    course: { ...actual.course, siteResources: jest.fn(), startHereProgress: jest.fn() },
    depthPreferences: { ...actual.depthPreferences, get: jest.fn() },
    habits: { ...actual.habits, updateGoalUnits: jest.fn(), listAll: jest.fn() },
    goals: { ...actual.goals, update: jest.fn() },
    userPractices: { ...actual.userPractices, linkHabit: jest.fn() },
    corpusConsent: { list: jest.fn(), set: jest.fn() },
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

const OWNER = 7;
const base64Url = (json: object): string =>
  btoa(JSON.stringify(json)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
const tokenFor = (owner: number, session: string): string =>
  `e30.${base64Url({ sub: String(owner), exp: 4_000_000_000, jti: session })}.sig`;

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

type Auth = ReturnType<typeof useAuth>;
type AuthOf = () => Auth;

const mockLogin = authApi.login as jest.MockedFunction<typeof authApi.login>;

async function signIn(auth: AuthOf, session: string) {
  mockLogin.mockResolvedValueOnce({
    token: tokenFor(OWNER, session),
    user_id: OWNER,
    timezone: 'UTC',
  });
  await act(async () => {
    await auth().login('owner@test.com', 'password123');
  });
  expect(auth().authStatus).toBe('authenticated');
}

/** Mount ``useHook`` beside the real auth state and sign the owner in. */
async function mountSignedIn<T>(useHook: () => T) {
  const view = renderHook(() => ({ auth: useAuth(), hook: useHook() }), { wrapper });
  const auth = () => view.result.current.auth;
  await waitFor(() => expect(auth().authStatus).not.toBe('loading'));
  await signIn(auth, 'first');
  return { view, auth, hook: () => view.result.current.hook };
}

/** The real in-place reauthentication: a 401 ends the session, the same account signs back in. */
async function reauthenticateSameOwner(auth: AuthOf) {
  const generation = getActiveUserGeneration();
  const session = getAuthSession();
  act(() => {
    auth().onUnauthorized();
  });
  await waitFor(() => expect(auth().authStatus).toBe('reauth-required'));
  await signIn(auth, 'second');
  // The gap this file pins: nothing about the account moved, only the session.
  expect(getActiveUser()).toBe(OWNER);
  expect(getActiveUserGeneration()).toBe(generation);
  expect(getAuthSession()).not.toBe(session);
}

/** A legitimate refresh: the same session, renewed in place. */
async function refreshToken(auth: AuthOf) {
  const session = getAuthSession();
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
    await waitFor(() => expect(auth().token).toBe(renewed));
  } finally {
    fetchSpy.mockRestore();
  }
  expect(getAuthSession()).toBe(session);
}

const interruptions = [
  ['a same-owner reauthentication', reauthenticateSameOwner, false],
  ['a legitimate token refresh (control)', refreshToken, true],
] as const;

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  resetAllStores();
  await AsyncStorage.clear();
  useDepthPreferencesStore.setState({ enable_habits: true });
  jest.mocked(habitsApi.listAll).mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Course: a reading captured before the session boundary', () => {
  test('the captured Course session is no longer current after reauthentication', async () => {
    const { auth } = await mountSignedIn(() => null);
    const session = captureCourseSession();
    expect(session?.current()).toBe(true);

    await reauthenticateSameOwner(auth);

    expect(session?.current()).toBe(false);
  });

  test.each(interruptions)('a Start Here read held across %s', async (_label, interrupt, lands) => {
    const { auth } = await mountSignedIn(() => null);
    const resources = deferred<SiteResource[]>();
    jest.mocked(course.siteResources).mockReturnValueOnce(resources.promise);
    jest.mocked(course.startHereProgress).mockResolvedValueOnce({
      stage_number: 0,
      total_items: 1,
      read_items: 0,
      progress_percent: 0,
      next_item: null,
    } as never);
    let loading!: Promise<unknown>;
    act(() => {
      loading = useStartHereStore.getState().load();
    });

    await interrupt(auth);
    await act(async () => {
      resources.resolve([{ slug: 'old-session', title: 'Old', order: 1 } as SiteResource]);
      await loading;
    });

    const state = useStartHereStore.getState();
    if (lands) {
      expect(state.status).toBe('ready');
      expect(state.resources.map((row) => row.slug)).toEqual(['old-session']);
    } else {
      // The old answer is never published; the surface offers its retry instead of spinning.
      expect(state.resources).toEqual([]);
      expect(state.status).toBe('error');
    }
  });

  test.each(interruptions)(
    'an Energy Scaffolding check held across %s',
    async (_label, interrupt, lands) => {
      const onOpen = jest.fn<void, [CourseSession]>();
      const { auth, hook } = await mountSignedIn(() => useEnergyScaffoldingHandoff(true, onOpen));
      const confirmed = deferred<DepthPreferences>();
      jest.mocked(depthPreferences.get).mockReturnValueOnce(confirmed.promise);
      act(() => {
        hook().start();
      });
      expect(hook().status).toBe('checking');

      await interrupt(auth);
      await act(async () => {
        confirmed.resolve({ enable_habits: true } as DepthPreferences);
        await confirmed.promise;
      });

      if (lands) {
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(hook().status).toBe('idle');
      } else {
        expect(onOpen).not.toHaveBeenCalled();
        // Not stuck on "checking": the button is offered again with its retry.
        expect(hook().status).toBe('error');
      }
    },
  );
});

const writingHabit = (): Habit => ({
  ...writingGoalDraft(),
  id: 42,
  name: 'Morning pages',
  goals: writingGoalDraft().goals.map((goal, index) => ({ ...goal, id: 101 + index })),
});

describe('Journal: a writing-goal save captured before the session boundary', () => {
  test.each(interruptions)('the goal writes held across %s', async (_label, interrupt, lands) => {
    const { auth } = await mountSignedIn(() => null);
    const units = deferred<Awaited<ReturnType<typeof habitsApi.updateGoalUnits>>>();
    jest.mocked(habitsApi.updateGoalUnits).mockReturnValueOnce(units.promise);
    jest.mocked(goals.update).mockResolvedValue({} as Awaited<ReturnType<typeof goals.update>>);
    useHabitStore.getState().setHabits([writingHabit()]);
    let saving!: Promise<Habit | null>;
    act(() => {
      saving = saveWritingHabitGoals(writingHabit(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC');
    });
    expect(habitsApi.updateGoalUnits).toHaveBeenCalledTimes(1);

    await interrupt(auth);
    let outcome: Habit | null | 'failed' = 'failed';
    await act(async () => {
      units.resolve([]);
      outcome = await saving.catch(() => 'failed' as const);
    });

    if (lands) {
      // The renewed session keeps writing the ladder it started.
      expect(goals.update).toHaveBeenCalledTimes(writingHabit().goals.length);
    } else {
      expect(goals.update).not.toHaveBeenCalled();
      expect(habitsApi.listAll).not.toHaveBeenCalled();
      expect(outcome).toBeNull();
    }
  });
});

describe('Practice: a habit link captured before the session boundary', () => {
  test.each(interruptions)('the link held across %s', async (_label, interrupt, lands) => {
    const practice = { id: 5, habit_id: 3 } as UserPractice;
    const onUpdated = jest.fn();
    const { auth, hook } = await mountSignedIn(() =>
      usePracticeHabitLink({ userPractice: practice, onUpdated }),
    );
    const response = deferred<UserPractice>();
    jest.mocked(userPractices.linkHabit).mockReturnValueOnce(response.promise);
    let saving!: Promise<boolean>;
    act(() => {
      saving = hook().save(9);
    });
    expect(hook().busy).toBe(true);

    await interrupt(auth);
    let saved: boolean | null = null;
    await act(async () => {
      response.resolve({ ...practice, habit_id: 9 });
      saved = await saving;
    });

    expect(saved).toBe(lands);
    expect(onUpdated).toHaveBeenCalledTimes(lands ? 1 : 0);
    // Either way the control is released rather than left spinning.
    expect(hook().busy).toBe(false);
  });
});

const undecided: CorpusConsent = { source: 'journal', granted: false, decided_at: null };

describe('Settings: a corpus-consent decision captured before the session boundary', () => {
  test.each(interruptions)('the decision held across %s', async (_label, interrupt, lands) => {
    jest.mocked(corpusConsent.list).mockResolvedValue([undecided]);
    const { auth, hook } = await mountSignedIn(() => useCorpusConsent());
    await waitFor(() => expect(hook().decisions).toEqual([undecided]));
    const response = deferred<CorpusConsent>();
    jest.mocked(corpusConsent.set).mockReturnValueOnce(response.promise);
    act(() => {
      hook().decide('journal', true);
    });
    expect(hook().pending).toEqual(['journal']);

    await interrupt(auth);
    await act(async () => {
      response.resolve({ source: 'journal', granted: true, decided_at: '2026-10-16T00:00:00Z' });
      await response.promise;
    });

    expect(hook().decisions?.[0]?.granted).toBe(lands);
    // The switch is released, not stuck pending.
    expect(hook().pending).toEqual([]);
  });
});

describe('Habits: a Course Energy handoff requested before the session boundary', () => {
  test.each(interruptions)('the held handoff across %s', async (_label, interrupt, lands) => {
    const open = jest.fn();
    const clear = jest.fn();
    let params: Parameters<typeof useEnergyOnboardingIntent>[0];
    const { view, auth, hook } = await mountSignedIn(() =>
      useEnergyOnboardingIntent(params, clear, open),
    );
    params = {
      onboardingIntent: 'energy-scaffolding',
      onboardingOwner: OWNER,
      onboardingGeneration: getActiveUserGeneration(),
      onboardingSession: getAuthSession(),
    };
    view.rerender({});
    expect(clear).toHaveBeenCalledTimes(1);
    expect(hook().status).toBe('waiting');

    await interrupt(auth);
    act(() => {
      useHabitStore.getState().setServerSync({ scope: habitSyncScopeKey(), status: 'ok' });
    });

    expect(open).toHaveBeenCalledTimes(lands ? 1 : 0);
    expect(hook().status).toBe('idle');
  });
});
