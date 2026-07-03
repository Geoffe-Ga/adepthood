/* eslint-env jest */
// Pins the icon-tap flow: opening the picker, selecting a tile, updating the habit icon, and closing.
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import HabitsScreen from '../HabitsScreen';

const mockUpdateHabit = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('../../../api', () => ({
  habits: {
    list: () =>
      Promise.resolve([
        {
          id: 1,
          name: 'Meditate',
          icon: '\u{1F9D8}',
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
    update: (...args: unknown[]) => mockUpdateHabit(...args),
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

describe('Habits icon-tap emoji picker', () => {
  it('opens the picker, selects a tile, updates the icon, and closes', async () => {
    const { getAllByTestId, getByTestId, queryByTestId } = render(<HabitsScreen />);

    const icons = await waitFor(() => getAllByTestId('habit-icon'));
    fireEvent.press(icons[0]!);

    await waitFor(() => expect(getByTestId('emoji-picker')).toBeTruthy());

    fireEvent.press(getByTestId('emoji-picker-select'));

    await waitFor(() => expect(mockUpdateHabit).toHaveBeenCalledTimes(1));
    expect(mockUpdateHabit.mock.calls[0]![0]).toBe(1);
    expect(mockUpdateHabit.mock.calls[0]![1]).toMatchObject({ icon: '\u{1F389}' });

    await waitFor(() => expect(queryByTestId('emoji-picker')).toBeNull());
  });
});
