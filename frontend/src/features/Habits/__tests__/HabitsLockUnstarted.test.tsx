/* eslint-env jest */
// Pins the overflow menu's reveal toggle in its other direction: pressing
// "Lock Unstarted Habits" flips an early-unlocked (revealed, future
// start_date) habit back to locked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React, { useSyncExternalStore } from 'react';

import type * as ApiModule from '../../../api';
import HabitsScreen from '../HabitsScreen';

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

// Renders the screen's headerLeft toggle in the same tree as the screen, so the
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

// HabitsScreen installs its drawer toggle as the navigator's headerLeft via
// useAppNavigation. Rendering the screen bare would strand that toggle in a
// detached tree whose presses never reach the screen's Modal-based drawer, so a
// small external store relays the headerLeft into the same tree (see harness).
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
  // The load path maps API rows through the real toLocalHabit; keep it so the
  // fixture below actually loads instead of throwing into the demo fallback.
  const actual: typeof ApiModule = jest.requireActual('../../../api');
  return {
    ...actual,
    habits: {
      listAll: () =>
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

jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: jest.fn(() => null) }));

beforeEach(() => {
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
});

describe('Habits drawer lock-unstarted toggle', () => {
  it('locks an early-unlocked habit via Lock Unstarted Habits', async () => {
    const { getAllByTestId, getByText, getByLabelText, queryByText, queryByLabelText } = render(
      <HabitsScreenWithHeader />,
    );

    await waitFor(() => expect(getAllByTestId('habit-icon').length).toBeGreaterThan(0));

    // The mocked fixture — the revealed, future-start "Early Habit" — is what
    // loaded, so it starts unlocked (no locked accessibility label yet).
    expect(queryByLabelText('Early Habit locked')).toBeNull();

    // The only seeded habit is revealed, so the toggle offers the lock action.
    fireEvent.press(getByLabelText('Open Habits menu'));
    fireEvent.press(getByText('Lock Unstarted Habits'));

    // Acting on a drawer row closes the drawer.
    await waitFor(() => expect(queryByText('Lock Unstarted Habits')).toBeNull());

    // The zero-completion fixture habit is now locked — its tile re-renders as a
    // locked tile carrying the "Early Habit locked" label.
    await waitFor(() => expect(getByLabelText('Early Habit locked')).toBeTruthy());
  });
});
