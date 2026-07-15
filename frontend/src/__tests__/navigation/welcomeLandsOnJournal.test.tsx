/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Regression locks for the journal-first landing: Welcome dismissal (Begin/Skip)
// opens the shell on Journal, via a REAL NavigationContainer/RootStack/BottomTabs
// harness (leaf screens stubbed) so getCurrentRoute() witnesses the focused tab.

// ─── Screen stubs (keep the navigation plumbing real) ───────────────────────

// WelcomeScreen stub: Begin fires onBegin+onComplete, Skip fires onComplete only.
jest.mock('@/features/Welcome/WelcomeScreen', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  const WelcomeStub = ({ onComplete, onBegin }: { onComplete: () => void; onBegin: () => void }) =>
    React.createElement(
      View,
      { testID: 'welcome-screen' },
      React.createElement(
        Pressable,
        {
          testID: 'welcome-begin',
          onPress: () => {
            onBegin();
            onComplete();
          },
        },
        React.createElement(Text, null, 'Begin'),
      ),
      React.createElement(
        Pressable,
        { testID: 'welcome-skip', onPress: onComplete },
        React.createElement(Text, null, 'Skip'),
      ),
    );
  return { __esModule: true, WelcomeScreen: WelcomeStub, default: WelcomeStub };
});

// Tab screens — minimal stubs with testIDs to allow containment checks.
jest.mock('@/features/Journal/JournalShelfScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'journal-screen' }, 'Journal');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Habits/HabitsScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'habits-screen' }, 'Habits');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Practice/PracticeScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'practice-screen' }, 'Practice');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Course/CourseScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'course-screen' }, 'Course');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Map/MapScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'map-screen' }, 'Map');
  return { __esModule: true, default: Stub };
});

// Modal screens that BottomTabs wraps via RootStack (Settings hub etc.)
jest.mock('@/features/Settings/SettingsHubScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'settings-screen' }, 'Settings');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Settings/ApiKeySettingsScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'ApiKey');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Settings/TimezoneSettingsScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'Timezone');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Settings/SupportCareScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'Support');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Practice/screens/SharePreviewScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'Share');
  return { __esModule: true, default: Stub };
});

jest.mock('@/features/Practice/screens/PracticeDetailScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'PracticeDetail');
  return { __esModule: true, PracticeDetailScreen: Stub };
});

jest.mock('@/features/Practice/screens/CreatePracticeWizard', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'CreatePractice');
  return { __esModule: true, CreatePracticeWizard: Stub };
});

jest.mock('@/features/Practice/screens/PracticeCatalogScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'Catalog');
  return { __esModule: true, PracticeCatalogScreen: Stub };
});

jest.mock('@/features/Journal/JournalEntryScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, null, 'JournalEntry');
  return { __esModule: true, default: Stub };
});

// Habit modals BottomTabs may import.
jest.mock('@/features/Habits/components/GoalModal', () => () => null);
jest.mock('@/features/Habits/components/HabitSettingsModal', () => () => null);
jest.mock('@/features/Habits/components/MissedDaysModal', () => () => null);
jest.mock('@/features/Habits/components/OnboardingModal', () => () => null);
jest.mock('@/features/Habits/components/ReorderHabitsModal', () => () => null);
jest.mock('@/features/Habits/components/StatsModal', () => () => null);

// Expo modules not available in Jest.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'token' }),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
}));

// Never-settling persist: proves markWelcomeSeen flips state before (not after)
// the fire-and-forget save — an awaited save would hang the shell render.
jest.mock('@/storage/welcomeStorage', () => ({
  __esModule: true,
  loadHasSeenWelcome: jest.fn(() => new Promise<boolean>(() => undefined)),
  saveHasSeenWelcome: jest.fn(() => new Promise<void>(() => undefined)),
  clearHasSeenWelcome: jest.fn(() => Promise.resolve()),
}));

// A never-settling GET falls through to the local-cache mock above so this
// file's direct useWelcomeStore.setState scenarios are unaffected.
jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: {
    get: jest.fn(() => new Promise(() => undefined)),
    update: jest.fn(() => new Promise(() => undefined)),
  },
}));

// ─── FeatureErrorBoundary — transparent pass-through ─────────────────────────
jest.mock('@/components/FeatureErrorBoundary', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Boundary = ({ children }: { children: React.ReactNode }) =>
    React.createElement(View, null, children);
  return { __esModule: true, FeatureErrorBoundary: Boundary };
});

// ─── Hooks / stores that heavy screens would normally activate ────────────────
jest.mock('@/store/useProgramStore', () => ({
  __esModule: true,
  useHydrateProgramStore: () => undefined,
  useProgramStore: () => ({ currentStage: null }),
}));

// Static imports AFTER all jest.mock() hoisting ───────────────────────────────
import type { NavigationContainerRef } from '@react-navigation/native';
import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { RootNavigator } from '@/App';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthStatus } from '@/context/AuthContext';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import { navThemeFor } from '@/navigation/theme';
import { useWelcomeStore } from '@/store/useWelcomeStore';

// Resolve the tab navigator's first route (else the focused route); early-returns
// keep the branch count under the complexity limit.
function firstTabName(
  navRef: React.RefObject<NavigationContainerRef<RootTabParamList>>,
): string | undefined {
  const container = navRef.current;
  if (!container) return undefined;
  const rootState = container.getRootState();
  if (!rootState) return container.getCurrentRoute()?.name;
  const tabRoute = rootState.routes.find((r) => r.name === 'Tabs') ?? rootState.routes[0];
  const tabState = tabRoute?.state;
  if (!tabState) return container.getCurrentRoute()?.name;
  return tabState.routes[0]?.name as string | undefined;
}

// ─── Auth mock helper ─────────────────────────────────────────────────────────

function mockAuthenticated(): void {
  jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    token: 'jwt',
    authStatus: 'authenticated' as AuthStatus,
    isLoading: false,
    userTimezone: 'UTC',
    setUserTimezone: jest.fn(),
    login: jest.fn(() => Promise.resolve()),
    signup: jest.fn(() => Promise.resolve()),
    logout: jest.fn(() => Promise.resolve()),
    onUnauthorized: jest.fn(),
    dismissReauth: jest.fn(() => Promise.resolve()),
    confirmPasswordReset: jest.fn(() => Promise.resolve()),
  } as unknown as ReturnType<typeof AuthContextModule.useAuth>);
}

// Wrap RootNavigator in a REAL NavigationContainer + ref so getCurrentRoute() works.
function renderWithNav(navRef: React.RefObject<NavigationContainerRef<RootTabParamList>>) {
  return render(
    <NavigationContainer theme={navThemeFor('light')} ref={navRef}>
      <RootNavigator />
    </NavigationContainer>,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.restoreAllMocks();
  mockAuthenticated();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Welcome → Journal landing', () => {
  // Begin (onBegin+onComplete → markSeen) lands on Journal; fails if the initial route reverts.
  it('Begin path: focused route is Journal after Welcome is dismissed', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: false }));

    const { getByTestId, queryByTestId } = renderWithNav(navRef);

    // Welcome is showing before Begin is pressed.
    expect(getByTestId('welcome-screen')).toBeTruthy();

    // Dismiss via the Begin path (mirrors production: onBegin + onComplete).
    act(() => {
      fireEvent.press(getByTestId('welcome-begin'));
    });

    // Welcome is gone immediately (synchronous state flip, no persist await).
    expect(queryByTestId('welcome-screen')).toBeNull();

    // Navigation state commits asynchronously; waitFor drains the tab
    // navigator's Animated update before asserting the route name.
    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  // Skip (onComplete only → markSeen) lands on Journal, same as Begin.
  it('Skip path: focused route is Journal after Welcome is dismissed', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: false }));

    const { getByTestId, queryByTestId } = renderWithNav(navRef);

    expect(getByTestId('welcome-screen')).toBeTruthy();

    act(() => {
      fireEvent.press(getByTestId('welcome-skip'));
    });

    expect(queryByTestId('welcome-screen')).toBeNull();

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  // Shell mounts on Journal while the persist is still pending — no blank frame.
  it('shell renders Journal without awaiting the persist (no blank frame)', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: false }));

    const { getByTestId, queryByTestId } = renderWithNav(navRef);

    act(() => {
      fireEvent.press(getByTestId('welcome-begin'));
    });

    // Shell is already mounted (no blank frame) even though saveHasSeenWelcome
    // never resolves — the persist is fire-and-forget.
    expect(queryByTestId('welcome-screen')).toBeNull();

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  // Returning user (hasSeenWelcome=true) skips Welcome and opens on Journal.
  it('returning user (hasSeenWelcome=true): shell opens on Journal without Welcome', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: true }));

    const { queryByTestId } = renderWithNav(navRef);

    // Welcome must never appear for a returning user.
    expect(queryByTestId('welcome-screen')).toBeNull();

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  // Pre-hydration (hasSeenWelcome=null) shows the shell on Journal, no Welcome flash.
  it('pre-hydration (hasSeenWelcome=null): Journal renders without Welcome flash', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: null }));

    const { queryByTestId } = renderWithNav(navRef);

    expect(queryByTestId('welcome-screen')).toBeNull();

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  // Journal is LEADING_TABS[0] (physical tab order), end-to-end from the Welcome path.
  it('Journal is the first route in the tab bar (LEADING_TABS[0])', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: true }));

    renderWithNav(navRef);

    await waitFor(() => {
      expect(firstTabName(navRef)).toBe('Journal');
    });
  });
});
