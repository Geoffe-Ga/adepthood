/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
/**
 * Regression-lock tests: after Welcome is dismissed via Begin or Skip, the
 * authenticated shell MUST open on the Journal tab (not Today). These tests
 * lock the journal-first initial route: ``initialRouteName="Journal"`` in
 * BottomTabs + ``TAB_CONFIGS[0] === Journal``.
 *
 * Mechanism: unlike ``welcomeGate.test.tsx`` (which stubs RootStack to a
 * plain testID marker), this harness keeps the REAL NavigationContainer,
 * RootStack, and BottomTabs so that ``NavigationContainerRef.getCurrentRoute()``
 * can witness which tab is focused. All individual tab *screens* and the
 * WelcomeScreen are mocked as lightweight stubs; the navigation plumbing is
 * genuine. ``saveHasSeenWelcome`` is a never-settling promise to prove the
 * shell swap does not await the async persist (no blank-frame regression).
 */

// ─── Screen stubs (keep the navigation plumbing real) ───────────────────────

// The WelcomeScreen mock exposes two pressable testIDs so tests can trigger
// the Begin path (onBegin + onComplete) and the Skip path (onComplete only),
// matching the production WelcomeScreen surface contract.
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

jest.mock('@/features/Today/TodayScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Stub = () => React.createElement(Text, { testID: 'today-screen' }, 'Today');
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

// Habit modals referenced by HabitsScreen (indirectly via mocked HabitsScreen
// above, but kept here for completeness in case BottomTabs imports them).
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

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

// ─── Storage: never-settling persist to prove no-blank-frame guarantee ───────
//
// ``saveHasSeenWelcome`` returns a promise that never resolves/rejects.
// ``markWelcomeSeen`` (Zustand) calls it as a fire-and-forget side-effect
// AFTER setting state synchronously. If the implementation were changed to
// await the persist before flipping ``hasSeenWelcome``, the Journal tab
// would never appear while this mock is in play — proving the regression.
jest.mock('@/storage/welcomeStorage', () => ({
  __esModule: true,
  loadHasSeenWelcome: jest.fn(() => new Promise<boolean>(() => undefined)),
  saveHasSeenWelcome: jest.fn(() => new Promise<void>(() => undefined)),
  clearHasSeenWelcome: jest.fn(() => Promise.resolve()),
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

// ─── Navigation state helper ──────────────────────────────────────────────────
//
// Resolves the effective first-tab name from the nav ref without embedding
// the drill-down logic inline (keeps each waitFor arrow trivially simple).
// Early-returns (rather than chained optionals) keep the branch count low:
// resolve the tab navigator's first route, else fall back to the focused route.
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

// ─── Focused harness ──────────────────────────────────────────────────────────
//
// Wraps RootNavigator in a REAL NavigationContainer with a ref so that
// ``navRef.current.getCurrentRoute()`` and ``getRootState()`` are available.
// The ``navThemeFor('light')`` call satisfies the theme shape that
// NavigationContainer expects (same as AppShell in production).

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
  /**
   * Test 1 — Begin path lands on Journal.
   *
   * First-run state (hasSeenWelcome=false) shows the WelcomeScreen stub.
   * Pressing the Begin button calls onBegin then onComplete, both of which
   * delegate to markSeen. markSeen sets hasSeenWelcome=true synchronously
   * (BEFORE the never-settling saveHasSeenWelcome resolves), so WelcomeGate
   * renders RootStack → BottomTabs immediately. The focused route MUST be
   * Journal (initialRouteName="Journal" in BottomTabs).
   *
   * Regression: if initialRouteName reverts to "Today" this fails because
   * getCurrentRoute().name would be "Today", not "Journal".
   */
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

  /**
   * Test 2 — Skip path lands on Journal.
   *
   * Skip calls onComplete only (onBegin is NOT called). Both paths call
   * markSeen, so the landing tab must be the same: Journal.
   *
   * Regression: same as Test 1 — initialRouteName revert or an explicit
   * navigate('Today') redirect introduced would break this.
   */
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

  /**
   * Test 3 — No intermediate blank screen (persist non-blocking).
   *
   * ``saveHasSeenWelcome`` is mocked as a never-settling promise (it will
   * never resolve during this test). After pressing Begin, the shell (with
   * Journal as the focused route) must already be rendered — proving that
   * markSeen flips state synchronously and the WelcomeGate swap does NOT
   * await the persist. If the implementation were changed to await
   * saveHasSeenWelcome before flipping hasSeenWelcome, this test would hang
   * indefinitely inside the waitFor timeout.
   */
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

  /**
   * Test 4 — Returning user never sees Welcome; shell opens on Journal.
   *
   * hasSeenWelcome=true → WelcomeGate renders RootStack directly. The
   * focused route must be Journal.
   *
   * Regression: if initialRouteName reverts to "Today" or an explicit
   * navigate('Today') is added to the RootStack mount path, this fails.
   */
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

  /**
   * Test 5 — Pre-hydration no-flash preserved; Journal is the initial route.
   *
   * hasSeenWelcome=null (storage not yet read) → WelcomeGate renders
   * RootStack (isFirstRun is false). Shell must mount on Journal, and Welcome
   * must never appear. This locks the no-flash guarantee alongside the
   * journal-first landing change.
   *
   * Regression: if the gate logic is changed to show Welcome while null
   * (adding a third truthy branch), this fails.
   */
  it('pre-hydration (hasSeenWelcome=null): Journal renders without Welcome flash', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: null }));

    const { queryByTestId } = renderWithNav(navRef);

    expect(queryByTestId('welcome-screen')).toBeNull();

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  /**
   * Bonus — Journal is TAB_CONFIGS[0] (first in physical tab order).
   *
   * ``getRootState().routes[0].name`` is the first registered tab; it must
   * be Journal so that the keyboard / accessibility order starts at Journal.
   * Mirrors the assertion in BottomTabs.test.tsx ("Journal is the first tab
   * in navigation order") but from the end-to-end Welcome→shell path.
   *
   * Regression: reordering TAB_CONFIGS so Journal is no longer index 0 would
   * break this even if initialRouteName is still "Journal".
   */
  it('Journal is the first route in the tab bar (TAB_CONFIGS[0])', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();
    act(() => useWelcomeStore.setState({ hasSeenWelcome: true }));

    renderWithNav(navRef);

    await waitFor(() => {
      expect(firstTabName(navRef)).toBe('Journal');
    });
  });
});
