/* eslint-env jest */
// Pins the Edit-mode branch of ``openModalForMode``: tapping a tile while
// Edit mode is active opens the habit-settings modal, not the goal modal.
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import HabitsScreen from '../HabitsScreen';

interface SettingsModalProps {
  visible: boolean;
}

const mockHabitSettingsModal = jest.fn((_props: SettingsModalProps) => null);

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
jest.mock('../components/HabitSettingsModal', () => ({
  __esModule: true,
  default: (props: SettingsModalProps) => mockHabitSettingsModal(props),
}));
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: jest.fn(() => null) }));
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

describe('Habits Edit-mode tile tap', () => {
  it('opens the habit settings modal when a tile is tapped in Edit mode', async () => {
    const { getByTestId, getByText, getAllByTestId } = render(<HabitsScreen />);

    await waitFor(() => expect(getAllByTestId('habit-tile').length).toBeGreaterThan(0));

    fireEvent.press(getByTestId('overflow-menu-toggle'));
    fireEvent.press(getByText('Edit'));
    fireEvent.press(getAllByTestId('habit-tile')[0]!);

    await waitFor(() => {
      const calls = mockHabitSettingsModal.mock.calls;
      const last = calls[calls.length - 1]!;
      expect(last[0].visible).toBe(true);
    });
  });
});
