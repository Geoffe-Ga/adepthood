import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import HabitsScreen from '../HabitsScreen';

// Mock the API so HabitsScreen loads instantly with an empty list. Plain
// promise-returning functions avoid the typed-mock `never` inference of
// `@jest/globals`' `jest.fn().mockResolvedValue(...)`.
jest.mock('../../../api', () => ({
  habits: {
    list: () => Promise.resolve([]),
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
  useAuth: () => ({ token: 'test-token' }),
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

describe('HabitsScreen icon chrome (lucide-react-native)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('mounts the top-bar overflow toggle without throwing', async () => {
    const { getByTestId } = render(<HabitsScreen />);

    // The top-bar MoreHorizontal icon lives inside this toggle; mounting it
    // proves the native lucide icon renders under @testing-library/react-native.
    await waitFor(() => expect(getByTestId('overflow-menu-toggle')).toBeTruthy());
  });

  it('renders the overflow menu icons when the toggle is pressed', async () => {
    const { getByTestId, getByText } = render(<HabitsScreen />);

    const toggle = await waitFor(() => getByTestId('overflow-menu-toggle'));
    fireEvent.press(toggle);

    // The menu rows each render a lucide-react-native icon next to a label;
    // their presence proves the icon chrome mounts without throwing on native.
    expect(getByTestId('overflow-menu')).toBeTruthy();
    expect(getByText('Quick Log')).toBeTruthy();
    expect(getByText('Stats')).toBeTruthy();
    expect(getByText('Add Habit')).toBeTruthy();
  });
});
