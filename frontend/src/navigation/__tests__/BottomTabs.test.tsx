/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { act, render, waitFor } from '@testing-library/react-native';
import {
  BookOpen,
  Compass,
  Flower2,
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

// ---------------------------------------------------------------------------
// Depth-preferences store mock — selector-based, mutable per test.
// ---------------------------------------------------------------------------

type MockStoreState = {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;
};

const DEFAULT_STORE_STATE: MockStoreState = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

let mockStoreState: MockStoreState = { ...DEFAULT_STORE_STATE };

const setMockState = (patch: Partial<MockStoreState>): void => {
  mockStoreState = { ...mockStoreState, ...patch };
};

const mockLoad = jest.fn<Promise<void>, []>(() => Promise.resolve());

jest.mock('@/store/useDepthPreferencesStore', () => ({
  useDepthPreferencesStore: jest.fn((selector: (_s: MockStoreState) => unknown) =>
    selector(mockStoreState),
  ),
  selectEnableHabits: (s: MockStoreState): boolean => s.enable_habits,
  selectEnablePractices: (s: MockStoreState): boolean => s.enable_practices,
  selectEnableCourse: (s: MockStoreState): boolean => s.enable_course,
  selectEnableSangha: (s: MockStoreState): boolean => s.enable_sangha,
  get load() {
    return mockLoad;
  },
}));

// ---------------------------------------------------------------------------
// Auth mock — provides token for load-on-mount assertions.
// ---------------------------------------------------------------------------

// Variables inside jest.mock factories must start with "mock" (Jest hoisting rule).
const mockToken = 'test-auth-token';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-auth-token', logout: jest.fn() }),
}));

import BottomTabs, { type RootTabParamList } from '../BottomTabs';

// ---------------------------------------------------------------------------
// Reset mutable state between tests.
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreState = { ...DEFAULT_STORE_STATE };
});

// ---------------------------------------------------------------------------
// Original suite — preserved; store mock defaults all-on so they stay green.
// ---------------------------------------------------------------------------

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

  it('renders a lucide icon for each of the five tabs', () => {
    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // The focused tab's icon may render more than once (active-state
    // animation in @react-navigation/bottom-tabs); only assert each icon
    // appears at least once, which is what makeTabIcon being invoked
    // for every assembled tab (LEADING_TABS + rings + TRAILING_TABS) guarantees.
    for (const Icon of [NotebookPen, Sprout, Flower2, BookOpen, Compass]) {
      expect(UNSAFE_getAllByType(Icon).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('no longer renders the Catalog tab (moved off the bottom nav)', () => {
    const { UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // LayoutGrid was the Catalog tab icon; it must be absent now (5 tabs).
    expect(UNSAFE_queryAllByType(LayoutGrid)).toHaveLength(0);
  });

  it('opens into the Journal tab as the initial route', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // waitFor: the navigation state commits asynchronously, and polling inside
    // act() also drains the tab bar's Animated update (else an act() warning).
    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });

  it('Journal is the first tab in navigation order', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // getRootState() (not a bare getState(), which can read undefined before
    // commit) exposes routes[] in physical tab order; waitFor lets it commit.
    await waitFor(() => {
      expect(navRef.current?.getRootState()?.routes?.[0]?.name).toBe('Journal');
    });
  });
});

// ---------------------------------------------------------------------------
// Conditional ring tabs — store-gated tab visibility (RED suite).
// ---------------------------------------------------------------------------

describe('BottomTabs — conditional ring tabs: all-on regression', () => {
  it('all five lucide tab icons render when all ring flags are true', () => {
    // Store defaults to all-on; this is the regression guard for the five-tab set.
    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    for (const Icon of [NotebookPen, Sprout, Flower2, BookOpen, Compass]) {
      expect(UNSAFE_getAllByType(Icon).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('BottomTabs — conditional ring tabs: enable_habits=false', () => {
  it('Sprout (Habits) icon is absent when enable_habits is false', () => {
    setMockState({ enable_habits: false });

    const { UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_queryAllByType(Sprout)).toHaveLength(0);
  });

  it('Journal/Map tabs still render when enable_habits is false', () => {
    setMockState({ enable_habits: false });

    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_getAllByType(NotebookPen).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Compass).length).toBeGreaterThanOrEqual(1);
  });

  it('Practice and Course tabs still render when only enable_habits is false', () => {
    setMockState({ enable_habits: false });

    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_getAllByType(Flower2).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(BookOpen).length).toBeGreaterThanOrEqual(1);
  });
});

describe('BottomTabs — conditional ring tabs: enable_practices=false', () => {
  it('Flower2 (Practice) icon is absent when enable_practices is false', () => {
    setMockState({ enable_practices: false });

    const { UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_queryAllByType(Flower2)).toHaveLength(0);
  });

  it('Journal/Map/Habits/Course render when only enable_practices is false', () => {
    setMockState({ enable_practices: false });

    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_getAllByType(NotebookPen).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Sprout).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(BookOpen).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Compass).length).toBeGreaterThanOrEqual(1);
  });
});

describe('BottomTabs — conditional ring tabs: enable_course=false', () => {
  it('BookOpen (Course) icon is absent when enable_course is false', () => {
    setMockState({ enable_course: false });

    const { UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_queryAllByType(BookOpen)).toHaveLength(0);
  });

  it('Journal/Map/Habits/Practice render when only enable_course is false', () => {
    setMockState({ enable_course: false });

    const { UNSAFE_getAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_getAllByType(NotebookPen).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Sprout).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Flower2).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Compass).length).toBeGreaterThanOrEqual(1);
  });
});

describe('BottomTabs — conditional ring tabs: all three rings off', () => {
  it('only Journal/Map icons render when all ring flags are false', () => {
    setMockState({ enable_habits: false, enable_practices: false, enable_course: false });

    const { UNSAFE_getAllByType, UNSAFE_queryAllByType } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // Always-present tabs.
    expect(UNSAFE_getAllByType(NotebookPen).length).toBeGreaterThanOrEqual(1);
    expect(UNSAFE_getAllByType(Compass).length).toBeGreaterThanOrEqual(1);

    // Gated tabs must be absent.
    expect(UNSAFE_queryAllByType(Sprout)).toHaveLength(0);
    expect(UNSAFE_queryAllByType(Flower2)).toHaveLength(0);
    expect(UNSAFE_queryAllByType(BookOpen)).toHaveLength(0);
  });
});

describe('BottomTabs — conditional ring tabs: live enable', () => {
  it('Sprout appears after enable_habits flips from false to true on re-render', () => {
    setMockState({ enable_habits: false });

    const { UNSAFE_queryAllByType, rerender } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // Sprout must be absent before the flag flips.
    expect(UNSAFE_queryAllByType(Sprout)).toHaveLength(0);

    // Flip the flag in the mutable mock state, then re-render the tree.
    act(() => {
      setMockState({ enable_habits: true });
    });

    rerender(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_queryAllByType(Sprout).length).toBeGreaterThanOrEqual(1);
  });
});

describe('BottomTabs — conditional ring tabs: focus-redirect on disable', () => {
  it('navigates to Journal when the focused tab becomes disabled, with no crash', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    const { rerender } = render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // Navigate to Habits so it is the focused route.
    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });

    act(() => {
      navRef.current?.navigate('Habits');
    });

    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Habits');
    });

    // Now disable Habits in the store and re-render to trigger the redirect effect.
    act(() => {
      setMockState({ enable_habits: false });
    });

    rerender(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // The component must redirect focus back to Journal.
    await waitFor(() => {
      expect(navRef.current?.getCurrentRoute()?.name).toBe('Journal');
    });
  });
});

describe('BottomTabs — conditional ring tabs: tab-count invariant', () => {
  it('renders exactly 2 tabs (Journal+Map) when all rings are off', async () => {
    setMockState({ enable_habits: false, enable_practices: false, enable_course: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // getRootState().routes[] length equals the number of mounted tabs.
    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      expect(routes).toHaveLength(2);
    });
  });

  it('renders exactly 5 tabs (Journal+3 rings+Map) when all rings are on', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      expect(routes).toHaveLength(5);
    });
  });

  it('renders exactly 3 tabs when only enable_habits is true', async () => {
    setMockState({ enable_practices: false, enable_course: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      expect(routes).toHaveLength(3);
    });
  });

  it('no Sangha tab exists in routes regardless of store state', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).not.toContain('Sangha');
    });
  });
});

describe('BottomTabs — conditional ring tabs: tab render order', () => {
  it('tab order is [Journal, Habits, Practice, Course, Map] when all rings on', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Habits', 'Practice', 'Course', 'Map']);
    });
  });

  it('tab order is [Journal, Map] when all rings are off', async () => {
    setMockState({ enable_habits: false, enable_practices: false, enable_course: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Map']);
    });
  });

  it('tab order is [Journal, Practice, Map] when only practices is enabled', async () => {
    setMockState({ enable_habits: false, enable_course: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Practice', 'Map']);
    });
  });
});

describe('BottomTabs — load-on-mount', () => {
  it('calls the store load function with the auth token exactly once on mount', () => {
    render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledWith(mockToken);
  });

  it('does not call load again on re-render without unmount', () => {
    const { rerender } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    rerender(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    // Load is mount-only; re-renders must not trigger extra fetches.
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
