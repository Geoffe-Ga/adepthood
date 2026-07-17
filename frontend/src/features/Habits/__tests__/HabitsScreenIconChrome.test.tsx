import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

// HabitsScreen now installs its header-left toggle through useAppNavigation
// (useScreenDrawer); mock the navigation hooks module so the screen renders
// outside a real NavigationContainer. mockSetOptions is prefixed "mock" so
// jest's hoist plugin allows the jest.mock factory to reference it.
const mockSetOptions = jest.fn();
jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ setOptions: mockSetOptions }),
}));
// The drawer nav section dispatches through the root stack via useNavigation;
// stub it so the screen renders outside a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

// Mock the API so HabitsScreen loads instantly with an empty list. Plain
// promise-returning functions avoid the typed-mock `never` inference of
// `@jest/globals`' `jest.fn().mockResolvedValue(...)`.
jest.mock('../../../api', () => ({
  habits: {
    listAll: () => Promise.resolve([]),
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
  // useHabitUI hydrates the energy-CTA flag server-first via uiFlags.get.
  uiFlags: {
    get: () => Promise.reject(new Error('no server hydration configured')),
    update: jest.fn(),
  },
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

import HabitsScreen from '../HabitsScreen';

interface HeaderLeftOptions {
  headerLeft: (() => React.ReactElement) | undefined;
}

describe('HabitsScreen top-bar chrome', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not render the removed in-body overflow menu toggle', () => {
    const { queryByTestId } = render(<HabitsScreen />);
    expect(queryByTestId('overflow-menu-toggle')).toBeNull();
    expect(queryByTestId('overflow-menu')).toBeNull();
  });

  it('installs a header-left drawer toggle via useAppNavigation', async () => {
    render(<HabitsScreen />);
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

    const lastCall = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1];
    if (lastCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const options = lastCall[0] as HeaderLeftOptions;
    expect(typeof options.headerLeft).toBe('function');
  });

  it('opens the header drawer and renders the menu rows when the toggle is pressed', async () => {
    const { getByTestId, getByText } = render(<HabitsScreen />);
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

    const lastCall = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1];
    if (lastCall === undefined) {
      throw new Error('expected a setOptions call');
    }
    const headerLeft = (lastCall[0] as HeaderLeftOptions).headerLeft;
    if (headerLeft === undefined) {
      throw new Error('headerLeft was not installed');
    }

    const { getByTestId: getByTestIdInToggle } = render(headerLeft());
    fireEvent.press(getByTestIdInToggle('drawer-toggle'));

    // The menu rows each render a lucide-react-native icon next to a label;
    // their presence proves the icon chrome mounts without throwing on native.
    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
    expect(getByText('Quick Log')).toBeTruthy();
    expect(getByText('Stats')).toBeTruthy();
    expect(getByText('Add Habit')).toBeTruthy();
  });
});
