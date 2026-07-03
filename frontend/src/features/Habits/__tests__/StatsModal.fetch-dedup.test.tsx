// Dedup guard: opening the Habits stats modal must fire habitsApi.getStats
// exactly once. Previously both useHabitStats and a useEffect inside StatsModal
// fetched, doubling the call. This drives the real open flow through
// HabitsScreen with the real StatsModal, so a re-introduced second fetch would
// make the count 2.
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import HabitsScreen from '../HabitsScreen';

const mockGetStats = jest.fn();

jest.mock('../../../api', () => ({
  habits: {
    // One unlocked habit (past start_date) so the tile renders and is pressable.
    list: () =>
      Promise.resolve([
        {
          id: 1,
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
}));

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

describe('Habits stats modal fetch dedup', () => {
  it('fires getStats exactly once when the stats modal opens', async () => {
    const { getByTestId, getAllByTestId, getByText } = render(<HabitsScreen />);

    // Wait for the habit list to load, then drive: overflow menu → Stats mode →
    // tap the tile (which opens the stats modal in stats mode).
    const toggle = await waitFor(() => getByTestId('overflow-menu-toggle'));
    fireEvent.press(toggle);
    fireEvent.press(getByText('Stats'));
    fireEvent.press(getAllByTestId('habit-tile')[0]!);

    await waitFor(() => expect(mockGetStats).toHaveBeenCalledTimes(1));
    expect(mockGetStats).toHaveBeenCalledWith(1, 'test-token');
  });
});
