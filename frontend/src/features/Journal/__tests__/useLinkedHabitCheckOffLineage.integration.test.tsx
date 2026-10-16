/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { useLinkedHabitCheckOff } from '../useLinkedHabitCheckOff';
import { checkOffLinkedHabit, type CheckOffRequest } from '../writingHabitCheckOff';
import type * as WritingHabitCheckOff from '../writingHabitCheckOff';
import { toWritingSessionResult, type LoggedWritingSession } from '../writingSession';

import { auth as authApi } from '@/api';
import { ToastProvider } from '@/components/ToastProvider';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';
import {
  UNAUTHORIZED,
  authFlows,
  createFakeServer,
  deferred,
  ok,
  refusals,
  type Reply,
} from '@/testing/sessionLineageHarness';

/**
 * #3452: a linked-habit check-off that crosses a same-account renewal.
 *
 * When a writing session ends, ``useLinkedHabitCheckOff`` logs the minutes
 * against the habit the writer linked. Its fence compared the exact JWT, so a
 * proactive refresh, or the check-in's own 401-refresh-retry, made the
 * confirmed check-in look stale: the minutes were logged on the server and
 * the writer never heard so. It now fences on the session lineage.
 *
 * The landing cases run the real check-off, habit refresh and check-in POST
 * over the real API client. The refusal cases read the fence the hook handed
 * the check-off directly, because the habit layer re-checks its own session
 * scope and would refuse on its own, pinning nothing about this hook.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, Record<string, unknown>>>('@/api');
  return { ...actual, auth: { ...actual.auth, login: jest.fn() } };
});

jest.mock('../writingHabitCheckOff', () => {
  const actual = jest.requireActual<typeof WritingHabitCheckOff>('../writingHabitCheckOff');
  return { ...actual, checkOffLinkedHabit: jest.fn(actual.checkOffLinkedHabit) };
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

const HABIT_ID = 42;
const WRITTEN_MINUTES = 20;
const PAGE_LIMIT = 50;
const TIERS = ['low', 'clear', 'stretch'] as const;
const TARGETS = { low: 10, clear: 20, stretch: 45 } as const;
const CHECK_IN_PATH = '/goal_completions/';
const RESULT = toWritingSessionResult({
  plannedMinutes: WRITTEN_MINUTES,
  elapsedMs: WRITTEN_MINUTES * 60_000,
});

const FLAGS: Reply = ok({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  course_last_stage: null,
  writing_session_habit_id: HABIT_ID,
});

const HABITS: Reply = ok({
  items: [
    {
      id: HABIT_ID,
      name: 'Morning pages',
      icon: '•',
      start_date: '2025-01-01',
      energy_cost: 1,
      energy_return: 2,
      milestone_notifications: false,
      stage: 'Beige',
      streak: 0,
      revealed: true,
      goals: TIERS.map((tier, index) => ({
        id: index + 101,
        habit_id: HABIT_ID,
        title: tier,
        tier,
        target: TARGETS[tier],
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
        completions: [],
      })),
    },
  ],
  total: 1,
  limit: PAGE_LIMIT,
  offset: 0,
  has_more: false,
});

const CHECKED_IN: Reply = ok({
  streak: 1,
  milestones: [],
  reason_code: 'units_adjusted',
  day_units: WRITTEN_MINUTES,
});

const server = createFakeServer({ '/ui-flags': FLAGS, '/habits/': HABITS });
const flows = authFlows(jest.mocked(authApi.login));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}

/** The hook beside the real auth state, signed in, with the link hydrated. */
async function mountLinked() {
  const inner = jest.fn();
  const onLogged = jest.fn<(_notice: LoggedWritingSession) => void>();
  const view = renderHook(
    () => ({ auth: useAuth(), finish: useLinkedHabitCheckOff(inner, onLogged) }),
    { wrapper },
  );
  const authOf = () => view.result.current.auth;
  await waitFor(() => expect(authOf().authStatus).not.toBe('loading'));
  await flows.signIn(authOf, 'first');
  await waitFor(() => expect(useWritingHabitLinkStore.getState().habitId).toBe(HABIT_ID));
  return { view, authOf, inner, onLogged, finish: () => view.result.current.finish };
}

beforeEach(async () => {
  jest.clearAllMocks();
  _resetSerializedWriteForTests();
  setActiveUser(null);
  resetAllStores();
  await AsyncStorage.clear();
  server.install();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('#3452: a linked-habit check-off across a same-account renewal', () => {
  test('a check-in held across a proactive renewal is logged and reported, once', async () => {
    const { authOf, inner, onLogged, finish } = await mountLinked();
    const checkIn = deferred<Reply>();
    server.answer(CHECK_IN_PATH, checkIn.promise);
    act(() => {
      finish()(RESULT);
    });
    await waitFor(() => expect(server.bearers(CHECK_IN_PATH, 'POST')).toHaveLength(1));

    await flows.renew(authOf);
    await act(async () => {
      checkIn.resolve(CHECKED_IN);
    });

    await waitFor(() => expect(onLogged).toHaveBeenCalledTimes(1));
    expect(onLogged.mock.calls[0]![0].result).toBe(RESULT);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(server.bearers(CHECK_IN_PATH, 'POST')).toHaveLength(1);
  });

  test('a check-in answered 401 is logged on its one retry, and no further', async () => {
    const { authOf, onLogged, finish } = await mountLinked();
    const first = authOf().token;
    // The retry is held until the renewed credential has rendered, as it would
    // be over a real network round-trip.
    const retried = deferred<Reply>();
    server.answer(CHECK_IN_PATH, UNAUTHORIZED, retried.promise);
    act(() => {
      finish()(RESULT);
    });
    await waitFor(() => expect(server.bearers(CHECK_IN_PATH, 'POST')).toHaveLength(2));
    await waitFor(() => expect(authOf().token).not.toBe(first));

    await act(async () => {
      retried.resolve(CHECKED_IN);
    });

    await waitFor(() => expect(onLogged).toHaveBeenCalledTimes(1));
    const sent = server.bearers(CHECK_IN_PATH, 'POST');
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });
});

describe("#3452: the hook's own fence still refuses every other boundary", () => {
  /** End a session and keep the fence the hook handed the check-off, without running it. */
  async function captureFence() {
    const mounted = await mountLinked();
    let request!: CheckOffRequest;
    jest.mocked(checkOffLinkedHabit).mockImplementationOnce(async (handed) => {
      request = handed;
    });
    act(() => {
      mounted.finish()(RESULT);
    });
    expect(checkOffLinkedHabit).toHaveBeenCalledTimes(1);
    expect(request.isCurrent?.()).toBe(true);
    return { ...mounted, isCurrent: () => request.isCurrent?.() };
  }

  test('the fence holds across a renewal (control)', async () => {
    const { authOf, isCurrent } = await captureFence();

    await flows.renew(authOf);

    expect(isCurrent()).toBe(true);
  });

  test.each(refusals(flows))('the fence refuses after %s', async (_label, interrupt) => {
    const { authOf, isCurrent } = await captureFence();

    await interrupt(authOf);

    expect(isCurrent()).toBe(false);
  });

  test('the fence refuses the moment a 401 ends the session, before any render', async () => {
    const { authOf, isCurrent } = await captureFence();
    let current: boolean | undefined;

    act(() => {
      authOf().onUnauthorized();
      current = isCurrent();
    });
    await waitFor(() => expect(authOf().authStatus).toBe('reauth-required'));

    expect(current).toBe(false);
  });
});
