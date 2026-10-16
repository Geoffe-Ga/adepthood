/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { saveWritingHabitGoals } from '../writingHabitGoals';
import type * as WritingHabitGoals from '../writingHabitGoals';
import WritingHabitPicker from '../WritingHabitPicker';

import { auth as authApi } from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Goal, Habit } from '@/features/Habits/Habits.types';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { useHabitStore } from '@/store/useHabitStore';
import {
  UNAUTHORIZED,
  authFlows,
  createFakeServer,
  deferred,
  ok,
  refusals,
  type Auth,
  type Reply,
} from '@/testing/sessionLineageHarness';

/**
 * #3452: a writing-habit goal save that crosses a same-account renewal.
 *
 * ``WritingHabitPicker`` fenced its save on the exact JWT, so a proactive
 * refresh or the save's own 401-refresh-retry closed the goal editor and
 * dropped the confirmed habit: the goals were written on the server and the
 * link was never made. It now fences on the session lineage.
 *
 * The landing cases run the real ``saveWritingHabitGoals`` over the real API
 * client. The refusal cases hold that helper's answer so the picker's own
 * fence is the only thing deciding: the helper re-checks its own scope, and a
 * refusal that passed only because of it would pin nothing here.
 */
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, Record<string, unknown>>>('@/api');
  return { ...actual, auth: { ...actual.auth, login: jest.fn() } };
});

jest.mock('../writingHabitGoals', () => {
  const actual = jest.requireActual<typeof WritingHabitGoals>('../writingHabitGoals');
  return { saveWritingHabitGoals: jest.fn(actual.saveWritingHabitGoals) };
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

const HABIT_ID = 20;
const HABITS_PATH = '/habits/';
const PAGE_LIMIT = 50;
const MINUTES = { low: 10, clear: 20, stretch: 45 } as const;
const TIERS = ['low', 'clear', 'stretch'] as const;

const server = createFakeServer();
const flows = authFlows(jest.mocked(authApi.login));

const goal = (tier: (typeof TIERS)[number], index: number): Goal => ({
  id: index + 1,
  title: tier,
  tier,
  target: 1,
  target_unit: 'pages',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
});

/** A habit on a unit the timer cannot count, so the picker offers to set it up. */
const PAGES: Habit = {
  id: HABIT_ID,
  stage: 'Beige',
  name: 'Read pages',
  icon: '•',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2025-01-01'),
  goals: TIERS.map(goal),
  completions: [],
  revealed: true,
};

/** The server's row once the default timer goals were written. */
const CONFIRMED_PAGE: Reply = ok({
  items: [
    {
      id: HABIT_ID,
      name: 'Read pages',
      icon: '•',
      start_date: '2025-01-01',
      energy_cost: 1,
      energy_return: 1,
      milestone_notifications: false,
      stage: 'Beige',
      streak: 0,
      revealed: true,
      goals: TIERS.map((tier, index) => ({
        id: index + 1,
        habit_id: HABIT_ID,
        title: tier,
        tier,
        target: MINUTES[tier],
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      })),
    },
  ],
  total: 1,
  limit: PAGE_LIMIT,
  offset: 0,
  has_more: false,
});

function answerGoalWrites(): void {
  server.answer(`/habits/${HABIT_ID}/goals/units`, ok([]));
  TIERS.forEach((_tier, index) => server.answer(`/goals/${index + 1}`, ok({})));
}

/** The picker beside the real auth state, signed in, with the goal editor open. */
async function mountEditor() {
  const onChoose = jest.fn<(_habit: Habit) => void>();
  let auth!: Auth;
  function Probe() {
    auth = useAuth();
    return null;
  }
  const view = render(
    <AuthProvider>
      <Probe />
      <WritingHabitPicker habits={[PAGES]} onChoose={onChoose} onCancel={jest.fn()} />
    </AuthProvider>,
  );
  const authOf = () => auth;
  await waitFor(() => expect(auth.authStatus).not.toBe('loading'));
  await flows.signIn(authOf, 'first');
  // Seeded after sign-in: adopting an account wipes the previous one's rows.
  act(() => {
    useHabitStore.getState().setHabits([PAGES]);
  });
  fireEvent.press(view.getByTestId(`writing-habit-configure-${HABIT_ID}`));
  expect(view.getByTestId('writing-habit-goals')).toBeTruthy();
  return { view, authOf, onChoose };
}

function save(view: ReturnType<typeof render>): void {
  fireEvent.press(view.getByTestId('writing-habit-goals-save'));
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

describe('#3452: a writing-habit goal save across a same-account renewal', () => {
  test('a save held across a proactive renewal links the habit, once', async () => {
    const { view, authOf, onChoose } = await mountEditor();
    answerGoalWrites();
    const confirm = deferred<Reply>();
    server.answer(HABITS_PATH, confirm.promise);
    save(view);
    await waitFor(() => expect(server.bearers(HABITS_PATH)).toHaveLength(1));

    await flows.renew(authOf);
    // The editor stays with its save; a renewal is not a new writer.
    expect(view.getByTestId('writing-habit-goals')).toBeTruthy();
    await act(async () => {
      confirm.resolve(CONFIRMED_PAGE);
    });

    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
    expect(onChoose.mock.calls[0]![0].id).toBe(HABIT_ID);
    expect(onChoose.mock.calls[0]![0].goals.map((g) => g.target_unit)).toEqual([
      'minutes',
      'minutes',
      'minutes',
    ]);
    expect(server.bearers(HABITS_PATH)).toHaveLength(1);
    expect(server.bearers(`/habits/${HABIT_ID}/goals/units`)).toHaveLength(1);
  });

  test('a save whose confirming read is answered 401 lands on its one retry, and no further', async () => {
    const { view, authOf, onChoose } = await mountEditor();
    const first = authOf().token;
    answerGoalWrites();
    // The retry is held until the renewed credential has rendered, as it would
    // be over a real network round-trip.
    const retried = deferred<Reply>();
    server.answer(HABITS_PATH, UNAUTHORIZED, retried.promise);

    save(view);
    await waitFor(() => expect(server.bearers(HABITS_PATH)).toHaveLength(2));
    await waitFor(() => expect(authOf().token).not.toBe(first));
    await act(async () => {
      retried.resolve(CONFIRMED_PAGE);
    });

    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
    const sent = server.bearers(HABITS_PATH);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(server.bearers(`/habits/${HABIT_ID}/goals/units`)).toHaveLength(1);
  });
});

describe("#3452: the picker's own fence still refuses every other boundary", () => {
  /** Hold the helper's answer so only the picker's fence decides whether it lands. */
  async function holdSave() {
    const mounted = await mountEditor();
    const answer = deferred<Habit | null>();
    jest.mocked(saveWritingHabitGoals).mockReturnValueOnce(answer.promise);
    save(mounted.view);
    expect(saveWritingHabitGoals).toHaveBeenCalledTimes(1);
    return { ...mounted, answer };
  }

  test('a held answer lands after a renewal (control)', async () => {
    const { authOf, onChoose, answer } = await holdSave();

    await flows.renew(authOf);
    await act(async () => {
      answer.resolve(PAGES);
    });

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(PAGES);
  });

  test.each(refusals(flows))('a held answer is dropped after %s', async (_label, interrupt) => {
    const { authOf, onChoose, answer } = await holdSave();

    await interrupt(authOf);
    await act(async () => {
      answer.resolve(PAGES);
    });

    expect(onChoose).not.toHaveBeenCalled();
  });

  test('a held answer that lands before a 401 has even rendered is dropped', async () => {
    const { authOf, onChoose, answer } = await holdSave();

    // The 401 ends the session at once; the answer lands before React renders
    // that, so only the captured session can tell it is stale.
    await act(async () => {
      authOf().onUnauthorized();
      answer.resolve(PAGES);
      await answer.promise;
    });
    await waitFor(() => expect(authOf().authStatus).toBe('reauth-required'));

    expect(onChoose).not.toHaveBeenCalled();
  });
});
