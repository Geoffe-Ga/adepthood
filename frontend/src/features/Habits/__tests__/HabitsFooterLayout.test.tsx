// The habits footer band -- the shared container behind the mode bar, the
// energy CTA and the error banner -- must sit in the layout flow rather than
// float over it. An absolutely positioned band contributes zero height, so the
// in-body pagination row (the last in-flow child, pushed flush to the bottom by
// the list's flexGrow) ends up underneath it and the Prev/Next buttons are
// buried. These tests pin the structural contract, since Jest computes no
// layout and cannot measure the overlap itself.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

// HabitsScreen installs its header-left drawer toggle through useAppNavigation;
// capture setOptions so a test can open the drawer that hosts the mode rows.
const mockSetOptions = jest.fn();
jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ setOptions: mockSetOptions }),
}));
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'token' })),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react');
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// An empty server list makes the loader seed the demo-fallback defaults, which
// are ten habits -- enough for a multi-page span, so the in-body pagination bar
// renders. paginationVisibilityStorage is deliberately NOT mocked so the bar's
// persisted-visible default (true) stands.
jest.mock('../../../api', () => ({
  habits: {
    listAll: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    getStats: jest.fn(() =>
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
    ),
  },
  goalCompletions: { create: jest.fn() },
  uiFlags: {
    get: jest.fn(() =>
      Promise.resolve({ has_seen_welcome: false, energy_scaffolding_archived: false }),
    ),
    update: jest.fn(() =>
      Promise.resolve({ has_seen_welcome: false, energy_scaffolding_archived: true }),
    ),
  },
}));

jest.mock('../components/AddHabitModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/GoalModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/HabitSettingsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/MissedDaysModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/OnboardingModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ReorderHabitsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/StatsModal', () => ({ __esModule: true, default: () => null }));

import HabitsScreen, { EnergyCTA, ErrorBanner, ModeBar } from '../HabitsScreen';

const noop = (): void => {};

/** The shape HabitsScreen hands to navigation's setOptions for its drawer toggle. */
interface CapturedHeaderOptions {
  headerLeft: () => React.ReactElement<{ onPress: () => void }>;
}

/** Press the captured header-left toggle to open the habits drawer. */
const openHabitsDrawer = (): void => {
  const lastCall = mockSetOptions.mock.calls.at(-1);
  if (!lastCall) throw new Error('HabitsScreen installed no header-left drawer toggle');
  const options = lastCall[0] as CapturedHeaderOptions;
  const toggle = options.headerLeft();
  act(() => {
    toggle.props.onPress();
  });
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('habits footer band layout', () => {
  const bands: [string, React.ReactElement][] = [
    ['ModeBar', <ModeBar key="m" mode="quickLog" onExit={noop} />],
    ['EnergyCTA', <EnergyCTA key="c" onOpen={noop} onArchive={noop} />],
    ['ErrorBanner', <ErrorBanner key="e" error="boom" onRetry={noop} />],
  ];

  it.each(bands)(
    'keeps the %s band in flow so it cannot paint over the pagination row',
    (_name, element) => {
      const { UNSAFE_root } = render(element);
      const band = UNSAFE_root.findAllByType(View)[0];
      const flat = StyleSheet.flatten(band.props.style as StyleProp<ViewStyle>);

      // Anchors the locator on the shared band itself rather than a child.
      expect(flat.flexDirection).toBe('row');
      // The contract: out-of-flow positioning is what buries the pagination row.
      expect(flat.position).toBeUndefined();
      expect(flat.bottom).toBeUndefined();
      expect(flat.left).toBeUndefined();
      expect(flat.right).toBeUndefined();
    },
  );

  it('reserves its own vertical space instead of overlaying the row below it', () => {
    const { UNSAFE_root } = render(<ModeBar mode="stats" onExit={noop} />);
    const band = UNSAFE_root.findAllByType(View)[0];
    const flat = StyleSheet.flatten(band.props.style as StyleProp<ViewStyle>);

    expect(flat.marginBottom).toBeGreaterThan(0);
    expect(flat.marginHorizontal).toBeGreaterThan(0);
  });
});

describe('habits pagination stays operable while a mode is active', () => {
  const modes: [string, string][] = [
    ['Quick Log', 'Quick Log Mode'],
    ['Stats', 'Stats Mode'],
    ['Edit', 'Edit Mode'],
  ];

  it.each(modes)('pages forward and back in %s mode', async (rowLabel, bannerLabel) => {
    const screen = render(<HabitsScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('habits-pagination')).toBeTruthy();
    });

    openHabitsDrawer();
    fireEvent.press(screen.getAllByText(rowLabel)[0]);

    // The mode banner and the pagination row are co-rendered siblings.
    expect(screen.getByText(bannerLabel)).toBeTruthy();
    expect(screen.getByTestId('exit-mode')).toBeTruthy();
    expect(screen.getByTestId('habits-pagination')).toBeTruthy();

    // Both controls still reach their handlers while the banner is up.
    const readLabel = (): unknown => screen.getByTestId('pagination-label').props.children;
    const first = readLabel();
    fireEvent.press(screen.getByTestId('pagination-next'));
    const second = readLabel();
    expect(second).not.toEqual(first);
    fireEvent.press(screen.getByTestId('pagination-prev'));
    expect(readLabel()).toEqual(first);

    screen.unmount();
  });
});
