/* eslint-env jest */
// Pins the Edit-mode branch of ``openModalForMode``: tapping a tile while
// Edit mode is active opens the habit-settings modal, not the goal modal.
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

interface SettingsModalProps {
  visible: boolean;
  habit: { id: number; name: string } | null;
}

const mockHabitSettingsModal = jest.fn((_props: SettingsModalProps) => null);

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
  // Keep the real ``toLocalHabit`` mapper the load path delegates to; stub only
  // the network namespaces this screen exercises.
  const actual: typeof ApiModule = jest.requireActual('../../../api');
  return {
    ...actual,
    habits: {
      // The id is deliberately distinct from FALLBACK_HABITS[0].id (1) so the
      // settings-modal assertion fails if the screen falls back to the demo seed.
      listAll: () =>
        Promise.resolve([
          {
            id: 7,
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
jest.mock('../components/HabitSettingsModal', () => ({
  __esModule: true,
  default: (props: SettingsModalProps) => mockHabitSettingsModal(props),
}));
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/AddHabitModal', () => () => null);
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: jest.fn(() => null) }));

beforeEach(() => {
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
});

describe('Habits Edit-mode tile tap', () => {
  it('opens the habit settings modal when a tile is tapped in Edit mode', async () => {
    const { getByText, getByLabelText, getAllByTestId } = render(<HabitsScreenWithHeader />);

    await waitFor(() => expect(getAllByTestId('habit-tile').length).toBeGreaterThan(0));

    fireEvent.press(getByLabelText('Open Habits menu'));
    fireEvent.press(getByText('Edit'));
    fireEvent.press(getAllByTestId('habit-tile')[0]!);

    await waitFor(() => {
      const calls = mockHabitSettingsModal.mock.calls;
      const last = calls[calls.length - 1]!;
      expect(last[0].visible).toBe(true);
      // The modal opened for the mocked fixture habit, not a fallback tile.
      expect(last[0].habit).toMatchObject({ id: 7, name: 'Meditate' });
    });
  });
});
