// Dedup guard: opening the Habits stats modal must fire habitsApi.getStats
// exactly once. Previously both useHabitStats and a useEffect inside StatsModal
// fetched, doubling the call. This drives the real open flow through
// HabitsScreen with the real StatsModal, so a re-introduced second fetch would
// make the count 2.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React, { useSyncExternalStore } from 'react';

import type * as ApiModule from '../../../api';
import { useHabitStore } from '../../../store/useHabitStore';
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
const mockListAll = jest.fn();

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
// The drawer nav section dispatches through the root stack via useNavigation;
// stub it so the screen renders outside a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: jest.fn() }),
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
      // Routed through a mock so a test can serve the demo seed instead. The
      // default row's id is deliberately distinct from FALLBACK_HABITS[0].id (1)
      // so the getStats assertion fails if the screen falls back to the seed.
      listAll: () => mockListAll(),
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

jest.mock('../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
  loadPendingCheckIns: jest.fn(() => Promise.resolve([])),
  clearPendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
  replacePendingCheckIns: jest.fn(() => Promise.resolve(undefined)),
  savePendingCheckIn: jest.fn(() => Promise.resolve(undefined)),
  recordDroppedCheckIn: jest.fn(() => Promise.resolve(undefined)),
  loadDroppedCheckIns: jest.fn(() => Promise.resolve([])),
  clearDroppedCheckIns: jest.fn(() => Promise.resolve(undefined)),
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

const SERVER_HABIT_ID = 7;

const serverHabits = [
  {
    id: SERVER_HABIT_ID,
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
];

const openStatsOnFirstTile = async (screen: ReturnType<typeof render>): Promise<void> => {
  await waitFor(() => expect(screen.getAllByTestId('habit-tile').length).toBeGreaterThan(0));
  fireEvent.press(screen.getByLabelText('Open Habits menu'));
  fireEvent.press(screen.getByText('Stats'));
  fireEvent.press(screen.getAllByTestId('habit-tile')[0]!);
};

beforeEach(() => {
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
  useHabitStore.setState({ habits: [], loading: false, error: null });
  mockListAll.mockImplementation(() => Promise.resolve(serverHabits));
});

describe('Habits stats modal fetch dedup', () => {
  it('fires getStats exactly once when the stats modal opens', async () => {
    const screen = render(<HabitsScreenWithHeader />);

    await openStatsOnFirstTile(screen);

    await waitFor(() => expect(mockGetStats).toHaveBeenCalledTimes(1));
    expect(mockGetStats).toHaveBeenCalledWith(SERVER_HABIT_ID, 'test-token');
  });
});

describe('Habits stats modal on a demo-seed tile', () => {
  it('renders locally generated stats without asking the server for them', async () => {
    // No cache and no server rows seeds the ten demo tiles, whose ids are fabricated.
    mockListAll.mockImplementation(() => Promise.resolve([]));
    const screen = render(<HabitsScreenWithHeader />);

    await openStatsOnFirstTile(screen);

    const seeded = useHabitStore.getState().habits;
    expect(seeded).toHaveLength(10);
    expect(seeded.filter((h) => h.isDemoSeed === true)).toHaveLength(10);
    expect(mockGetStats).not.toHaveBeenCalled();
    // Stats came from the local generator, so the modal never sits in its
    // in-flight state waiting on a request that will never be made.
    expect(screen.queryByText('Loading stats...')).toBeNull();
    expect(screen.getByText('Longest Streak:')).toBeTruthy();
    expect(screen.getByText('Total Completions:')).toBeTruthy();
  });
});
