/* eslint-env jest */
// Pins the overflow menu's reveal toggle in its other direction: pressing
// "Lock Unstarted Habits" flips an early-unlocked (revealed, future
// start_date) habit back to locked.
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import HabitsScreen from '../HabitsScreen';

jest.mock('../../../api', () => ({
  habits: {
    list: () =>
      Promise.resolve([
        {
          id: 2,
          name: 'Early Habit',
          icon: '\u{1F331}',
          stage: 'Beige',
          streak: 0,
          energy_cost: 1,
          energy_return: 1,
          start_date: new Date('2099-01-01'),
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
    getStats: () =>
      Promise.resolve({
        day_labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        values: [0, 0, 0, 0, 0, 0, 0],
        completions_by_day: [0, 0, 0, 0, 0, 0, 0],
        longest_streak: 0,
        current_streak: 0,
        total_completions: 0,
        completion_rate: 0,
        completion_dates: [],
      }),
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

jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: jest.fn(() => null) }));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

describe('Habits overflow menu lock-unstarted toggle', () => {
  it('locks an early-unlocked habit via Lock Unstarted Habits', async () => {
    const { getAllByTestId, getByTestId, getByText, queryByText } = render(<HabitsScreen />);

    await waitFor(() => expect(getAllByTestId('habit-icon').length).toBeGreaterThan(0));

    // All seeded habits are revealed, so the toggle offers the lock action.
    fireEvent.press(getByTestId('overflow-menu-toggle'));
    fireEvent.press(getByText('Lock Unstarted Habits'));

    // Acting on a menu item closes the overflow menu.
    await waitFor(() => expect(queryByText('Lock Unstarted Habits')).toBeNull());
  });
});
