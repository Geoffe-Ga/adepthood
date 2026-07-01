/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { render, waitFor } from '@testing-library/react-native';
import {
  BookOpen,
  Compass,
  Flower2,
  Home,
  LayoutGrid,
  NotebookPen,
  Settings,
  Sprout,
} from 'lucide-react-native';
import React from 'react';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
}));

jest.mock('@/features/Habits/components/GoalModal', () => () => null);
jest.mock('@/features/Habits/components/HabitSettingsModal', () => () => null);
jest.mock('@/features/Habits/components/MissedDaysModal', () => () => null);
jest.mock('@/features/Habits/components/OnboardingModal', () => () => null);
jest.mock('@/features/Habits/components/ReorderHabitsModal', () => () => null);
jest.mock('@/features/Habits/components/StatsModal', () => () => null);
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

import BottomTabs, { type RootTabParamList } from '../BottomTabs';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BottomTabs', () => {
  it('renders the settings gear in the header (logout moved to the hub)', () => {
    const { getByTestId } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(getByTestId('open-settings-button')).toBeTruthy();
  });

  it('renders the gear as the lucide Settings icon, not a logout text link', () => {
    const { UNSAFE_getAllByType, queryByText } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_getAllByType(Settings).length).toBeGreaterThanOrEqual(1);
    expect(queryByText('Logout')).toBeNull();
  });

  it('renders a lucide icon for each of the six tabs', () => {
    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // The focused tab's icon may render more than once (active-state
    // animation in @react-navigation/bottom-tabs); only assert each icon
    // appears at least once, which is what makeTabIcon being invoked
    // for every TAB_CONFIGS entry guarantees.
    for (const Icon of [Home, Sprout, Flower2, BookOpen, NotebookPen, Compass]) {
      expect(UNSAFE_getAllByType(Icon).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('no longer renders the Catalog tab (moved off the bottom nav)', () => {
    const { UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // LayoutGrid was the Catalog tab icon; it must be absent now (6 tabs).
    expect(UNSAFE_queryAllByType(LayoutGrid)).toHaveLength(0);
  });

  // Issue #900: Journal-first navigation — RED tests (fail until implementation).
  // The fix sets initialRouteName="Journal" and moves Journal to TAB_CONFIGS[0].

  it('opens into the Journal tab as the initial route (issue #900)', async () => {
    // NavigationContainerRef exposes getCurrentRoute() after the navigation
    // state commits. waitFor polls until the ref is populated, which also
    // flushes the Animated(View) update that would otherwise surface as an
    // act() warning.
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // getCurrentRoute() returns the leaf route that has focus. After mount with
    // initialRouteName="Journal" this must be "Journal", not "Today".
    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  it('Journal is the first tab in navigation order (issue #900)', async () => {
    // getState() on NavigationContainerRef is not guaranteed to be populated
    // synchronously at the point render() returns — the navigation state is
    // committed asynchronously by @react-navigation/native. waitFor() polls
    // until the assertion passes (or times out), giving the state time to
    // commit. This also flushes pending Animated updates inside act(), so no
    // act() warning is emitted.
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // getRootState() returns the committed root navigation state whose routes[]
    // array reflects the physical left-to-right tab ordering (TAB_CONFIGS order).
    // The container ref exposes getRootState() reliably (it backs
    // getCurrentRoute()); a bare getState() can read undefined before commit.
    // With TAB_CONFIGS[0] === Journal, routes[0].name must equal 'Journal'.
    await waitFor(() => {
      expect(navRef.current?.getRootState()?.routes?.[0]?.name).toBe('Journal');
    });
  });
});
