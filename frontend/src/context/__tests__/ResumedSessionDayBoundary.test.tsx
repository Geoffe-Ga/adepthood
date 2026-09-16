/**
 * The bug as the writer met it: "I just had to log out and log back in to get
 * my habits to reset for today so I could begin logging them." (#2847)
 *
 * This is the seam between the two halves that produced it, exercised together
 * rather than separately: the real `AuthProvider` resuming a session from a
 * stored token, and the real `useHabitsSummary` bucketing a completion into a
 * calendar day. Either half tested alone looks correct. `AuthContext` sets a
 * zone; `countDoneToday` buckets in whatever zone it is handed. Only the join
 * shows that the zone the resumed session hands it was UTC.
 *
 * The clock is pinned to 08:00 in Los Angeles on 2026-09-12, with the habit's
 * only completion logged at 20:30 the previous evening. In the user's own
 * calendar that is yesterday and nothing is done today; in UTC it is
 * 2026-09-12 03:30, which is *today*, so the tile lit up and the star tap
 * refused a second log. Logging out and back in is what fixed it, because
 * `POST /auth/login` is the one path that carried the zone.
 *
 * The assertion is over every render, not only the settled one. A single
 * authenticated render reporting one habit done is a tile that painted
 * "ACHIEVED TODAY!" on the wrong day, however quickly it corrected itself.
 */
/* eslint-env jest */
/* global describe, it, expect, beforeEach, afterEach, jest */
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

jest.mock('@/api', () => {
  const actual = jest.requireActual<typeof ApiModule>('@/api');
  return {
    ...actual,
    auth: { ...actual.auth, login: jest.fn(), refresh: jest.fn() },
    setTokenGetter: jest.fn(),
    setOnUnauthorized: jest.fn(),
    setOnTokenRefreshed: jest.fn(),
    resetLlmApiKey: jest.fn(),
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
  loadUserTimezone: jest.fn(() => Promise.resolve(null)),
  clearUserTimezone: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: { loadHabits: jest.fn(() => Promise.resolve()) },
}));

import { auth as authApi } from '@/api';
import type * as ApiModule from '@/api';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitsSummary } from '@/features/Journal/useHabitsSummary';
import { loadToken, loadUserTimezone } from '@/storage/authStorage';
import { useHabitStore } from '@/store/useHabitStore';

const mockAuthApi = authApi as jest.Mocked<typeof authApi>;
const mockLoadToken = loadToken as jest.MockedFunction<typeof loadToken>;
const mockLoadUserTimezone = loadUserTimezone as jest.MockedFunction<typeof loadUserTimezone>;

const WEST_TZ = 'America/Los_Angeles';

/**
 * A JWT the real `isTokenExpired` accepts: three segments, `exp` far ahead and
 * `iat` just behind, so nothing here is due for a proactive refresh either.
 */
const base64Url = (value: string): string =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const storedJwt = (nowSeconds: number): string =>
  [
    base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64Url(
      JSON.stringify({ sub: '7', iat: nowSeconds - 60, exp: nowSeconds + 30 * 24 * 60 * 60 }),
    ),
    'signature',
  ].join('.');

/** 2026-09-12 08:00 in Los Angeles — after UTC has already turned over to the 12th. */
const COLD_START_AT = new Date('2026-09-12T15:00:00.000Z');
/** 2026-09-11 20:30 in Los Angeles — yesterday evening, in the user's own calendar. */
const LOGGED_YESTERDAY_EVENING = new Date('2026-09-12T03:30:00.000Z');

const yesterdayEveningHabit = (): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Sit',
  icon: '🧘',
  streak: 3,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-09-01T00:00:00.000Z'),
  goals: [],
  completions: [{ id: 'c-1', timestamp: LOGGED_YESTERDAY_EVENING, completed_units: 1 }],
  revealed: true,
});

interface Painted {
  status: string;
  timezone: string;
  doneCount: number;
}

const painted: Painted[] = [];

function Shelf(): React.JSX.Element {
  const { authStatus, userTimezone } = useAuth();
  const { doneCount } = useHabitsSummary();
  painted.push({ status: authStatus, timezone: userTimezone, doneCount });
  return <Text testID="done-count">{String(doneCount)}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  painted.length = 0;
  jest.useFakeTimers();
  jest.setSystemTime(COLD_START_AT);
  mockLoadToken.mockResolvedValue(storedJwt(Math.floor(COLD_START_AT.getTime() / 1000)));
  mockLoadUserTimezone.mockResolvedValue(WEST_TZ);
  // The sliding renewal this token is armed for lands 15 days out; jest's
  // teardown runs pending timers, so give it a real response to settle on
  // rather than an unstubbed mock that throws inside the teardown.
  mockAuthApi.refresh.mockResolvedValue({ token: 'fresh-jwt', user_id: 7, timezone: WEST_TZ });
  useHabitStore.getState().setHabits([yesterdayEveningHabit()]);
});

afterEach(() => {
  jest.useRealTimers();
  useHabitStore.getState().setHabits([]);
});

describe('a session resumed west of UTC (#2847)', () => {
  it("counts last evening's completion as yesterday, not as today", async () => {
    const { getByTestId } = render(
      <AuthProvider>
        <Shelf />
      </AuthProvider>,
    );

    await waitFor(() => expect(painted.at(-1)?.status).toBe('authenticated'));

    expect(getByTestId('done-count').props.children).toBe('0');
    expect(painted.at(-1)?.timezone).toBe(WEST_TZ);
  });

  it('never shows the habit as done today, on any authenticated render', async () => {
    render(
      <AuthProvider>
        <Shelf />
      </AuthProvider>,
    );

    await waitFor(() => expect(painted.at(-1)?.status).toBe('authenticated'));

    expect(painted.filter((p) => p.status === 'authenticated' && p.doneCount > 0)).toEqual([]);
  });
});
