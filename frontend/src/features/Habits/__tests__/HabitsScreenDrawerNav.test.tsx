import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React, { useSyncExternalStore, type ReactElement } from 'react';

// RED coverage for the shared DrawerNavSection wired into the Habits header
// drawer. Mirrors PracticeScreenDrawerNav.test.tsx's headerLeftStore harness,
// adding a stable navigate spy so the shared nav rows have somewhere to route.
const mockNavigate = jest.fn();
// HabitsScreen installs its header-left drawer toggle through
// useAppNavigation (useScreenDrawer), which calls navigation.setOptions in a
// layout effect on every mount. The store relays the installed headerLeft
// into the same render tree as the screen so the Modal-based drawer opens
// in-tree and its rows are pressable.
const headerLeftStore: {
  current: (() => ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});
jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
}));

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

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

// Renders the screen's headerLeft toggle in the same tree as the screen, so
// the drawer opens in-tree and its rows are pressable.
const HabitsScreenWithHeader = (): ReactElement => {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <HabitsScreen />
    </>
  );
};

describe('Habits header drawer nav section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    headerLeftStore.current = undefined;
    headerLeftStore.listeners.clear();
    useDepthPreferencesStore.setState({
      enable_habits: true,
      enable_practices: true,
      enable_course: true,
    });
  });

  it("renders the nav section before the drawer's own rows, with a trailing divider", async () => {
    const { getByTestId, getByLabelText, toJSON } = render(<HabitsScreenWithHeader />);
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

    fireEvent.press(getByLabelText('Open Habits menu'));

    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
    expect(getByTestId('drawer-nav-Habits')).toBeTruthy();
    expect(getByTestId('drawer-nav-divider')).toBeTruthy();

    // toJSON() embeds React elements with circular _owner refs; strip those.
    const seen = new WeakSet();
    const json = JSON.stringify(toJSON(), (key, value) => {
      if (key === '_owner' || key === '_store') return undefined;
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined;
        seen.add(value);
      }
      return value;
    });
    const navIndex = json.indexOf('"testID":"drawer-nav-Habits"');
    const quickLogIndex = json.indexOf('"Quick Log"');
    expect(navIndex).toBeGreaterThan(-1);
    expect(quickLogIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeLessThan(quickLogIndex);
  });

  it('marks the Habits nav row selected', async () => {
    const { getByTestId, getByLabelText } = render(<HabitsScreenWithHeader />);
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

    fireEvent.press(getByLabelText('Open Habits menu'));

    expect(getByTestId('drawer-nav-Habits').props.accessibilityState.selected).toBe(true);
  });

  it('navigating to a different screen from the nav section closes the drawer', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<HabitsScreenWithHeader />);
    await waitFor(() => expect(mockSetOptions).toHaveBeenCalled());

    fireEvent.press(getByLabelText('Open Habits menu'));
    fireEvent.press(getByTestId('drawer-nav-Journal'));

    expect(mockNavigate).toHaveBeenCalledWith('Journal');
    expect(queryByTestId('screen-drawer-panel')).toBeNull();
  });
});
