// Dedup guard: opening the Habits stats modal must fire habitsApi.getStats
// exactly once. Previously both useHabitStats and a useEffect inside StatsModal
// fetched, doubling the call. This drives the real open flow through
// HabitsScreen with the real StatsModal, so a re-introduced second fetch would
// make the count 2.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React, { useSyncExternalStore } from 'react';

import type * as ApiModule from '../../../api';
import HabitsScreen from '../HabitsScreen';

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

// Renders the screen's headerLeft toggle in the same tree as the screen so the
// drawer opens in-tree and its rows are pressable.
const HabitsScreenWithHeader = (): React.JSX.Element => {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <HabitsScreen />
    </>
  );
};

const mockGetStats = jest.fn();

// HabitsScreen installs its drawer toggle as the navigator's headerLeft via
// useAppNavigation. Rendering the screen outside a navigator would strand that
// toggle in a detached tree whose presses never reach the screen's Modal-based
// drawer, so a small external store relays the headerLeft into the same tree.
const headerLeftStore: {
  current: (() => React.ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => React.ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});
jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ setOptions: mockSetOptions }),
}));

jest.mock('../../../api', () => {
  // Keep the real ``toLocalHabit`` mapper the load path delegates to; stub only
  // the network namespaces this screen exercises.
  const actual: typeof ApiModule = jest.requireActual('../../../api');
  return {
    ...actual,
    // useHabitUI hydrates the energy-CTA flag server-first via uiFlags.get.
    uiFlags: {
      get: jest.fn(() =>
        Promise.resolve({
          has_seen_welcome: false,
          energy_scaffolding_archived: false,
        }),
      ),
      update: jest.fn(() =>
        Promise.resolve({
          has_seen_welcome: false,
          energy_scaffolding_archived: false,
        }),
      ),
    },
    habits: {
      // One unlocked habit (past start_date) so the tile renders and is pressable.
      // Its id is deliberately distinct from FALLBACK_HABITS[0].id (1) so the
      // getStats assertion fails if the screen ever falls back to the demo seed.
      listAll: () =>
        Promise.resolve([
          {
            id: 7,
            name: 'Meditate',
            icon: '🧘',
            stage: 'Beige',
            streak: 0,
            energy_cost: 1,
            energy_return: 1,
            start_date: new Date(2020, 0, 1),
            goals: [
              {
                title: 'Low',
                tier: 'low',
                target: 1,
                target_unit: 'u',
                frequency: 1,
                frequency_unit: 'per_day',
                is_additive: true,
              },
            ],
            completions: [],
            revealed: true,
          },
        ]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getStats: (...args: unknown[]) => {
        mockGetStats(...args);
        return Promise.resolve({
          day_labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          values: [0, 0, 0, 0, 0, 0, 0],
          completions_by_day: [0, 0, 0, 0, 0, 0, 0],
          longest_streak: 0,
          current_streak: 0,
          total_completions: 0,
          completion_rate: 0,
          completion_dates: [],
        });
      },
    },
    goalCompletions: { create: jest.fn() },
  };
});

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => Promise.resolve({ status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getAllScheduledNotificationsAsync: () => Promise.resolve([]),
  getExpoPushTokenAsync: () => Promise.resolve({ data: 'token' }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// Chart/calendar libs don't render under the test renderer.
jest.mock('react-native-calendars', () => ({ Calendar: () => null }));
jest.mock('react-native-chart-kit', () => ({ LineChart: () => null, BarChart: () => null }));
jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/AddHabitModal', () => () => null);

beforeEach(() => {
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
});

describe('Habits stats modal fetch dedup', () => {
  it('fires getStats exactly once when the stats modal opens', async () => {
    const { getAllByTestId, getByText, getByLabelText } = render(<HabitsScreenWithHeader />);

    // Wait for the habit list to load, then drive: header drawer -> Stats mode ->
    // tap the tile (which opens the stats modal in stats mode).
    await waitFor(() => expect(getAllByTestId('habit-tile').length).toBeGreaterThan(0));
    fireEvent.press(getByLabelText('Open Habits menu'));
    fireEvent.press(getByText('Stats'));
    fireEvent.press(getAllByTestId('habit-tile')[0]!);

    await waitFor(() => expect(mockGetStats).toHaveBeenCalledTimes(1));
    expect(mockGetStats).toHaveBeenCalledWith(7, 'test-token');
  });
});
