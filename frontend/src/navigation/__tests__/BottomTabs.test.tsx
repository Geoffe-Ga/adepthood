/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { BottomTabBar } from '@react-navigation/bottom-tabs';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { act, render, waitFor } from '@testing-library/react-native';
import { BookOpen, Compass, Flower2, NotebookPen, Settings, Sprout } from 'lucide-react-native';
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

// The token the AuthContext mock returns; asserted by the load-on-mount tests.
const mockToken = 'test-auth-token';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-auth-token', logout: jest.fn() }),
}));

import BottomTabs, { type RootTabParamList } from '../BottomTabs';
import { NAV_DESTINATIONS } from '../destinations';

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

  it('opens into the Journal tab as the initial route', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // waitFor: the navigation state commits asynchronously.
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

    // getRootState() exposes routes[] in physical tab order; waitFor lets it commit.
    await waitFor(() => {
      expect(navRef.current?.getRootState()?.routes?.[0]?.name).toBe('Journal');
    });
  });
});

// ---------------------------------------------------------------------------
// Drawer is primary navigation — the bottom tab bar itself must not render.
// ---------------------------------------------------------------------------

describe('BottomTabs — drawer is primary navigation (no tab bar)', () => {
  it('renders no tab bar and no tab-bar icons; the settings gear still renders', () => {
    const { UNSAFE_queryAllByType, getByTestId } = render(
      <NavigationContainer>
        <BottomTabs />
      </NavigationContainer>,
    );

    expect(UNSAFE_queryAllByType(BottomTabBar)).toHaveLength(0);

    for (const Icon of [NotebookPen, Sprout, Flower2, BookOpen, Compass]) {
      expect(UNSAFE_queryAllByType(Icon)).toHaveLength(0);
    }

    expect(getByTestId('open-settings-button')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Conditional ring tabs — store-gated route visibility, asserted on the
// mounted route set rather than on tab-bar icons (no tab bar renders now).
// ---------------------------------------------------------------------------

describe('BottomTabs — conditional ring tabs: all-on regression', () => {
  it('all five routes mount when all ring flags are true', async () => {
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
});

describe('BottomTabs — conditional ring tabs: enable_habits=false', () => {
  it('route order excludes Habits when enable_habits is false', async () => {
    setMockState({ enable_habits: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Practice', 'Course', 'Map']);
    });
  });
});

describe('BottomTabs — conditional ring tabs: enable_practices=false', () => {
  it('route order excludes Practice when enable_practices is false', async () => {
    setMockState({ enable_practices: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Habits', 'Course', 'Map']);
    });
  });
});

describe('BottomTabs — conditional ring tabs: enable_course=false', () => {
  it('route order excludes Course when enable_course is false', async () => {
    setMockState({ enable_course: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(['Journal', 'Habits', 'Practice', 'Map']);
    });
  });
});

describe('BottomTabs — conditional ring tabs: all three rings off', () => {
  it('route order is Journal/Map only when all ring flags are false', async () => {
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
});

describe('BottomTabs — conditional ring tabs: live enable', () => {
  it('routes include Habits after enable_habits flips from false to true on re-render', async () => {
    setMockState({ enable_habits: false });

    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    const { rerender } = render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    // Habits must be absent before the flag flips.
    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).not.toContain('Habits');
    });

    // Flip the flag in the mutable mock state, then re-render the tree.
    act(() => {
      setMockState({ enable_habits: true });
    });

    rerender(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toContain('Habits');
    });
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

  it('mounted route order equals the NAV_DESTINATIONS registry order (all rings on)', async () => {
    const navRef = React.createRef<NavigationContainerRef<RootTabParamList>>();

    render(
      <NavigationContainer ref={navRef}>
        <BottomTabs />
      </NavigationContainer>,
    );

    await waitFor(() => {
      const routes = navRef.current?.getRootState()?.routes ?? [];
      const names = routes.map((r: { name: string }) => r.name);
      expect(names).toEqual(NAV_DESTINATIONS.map((d) => d.name));
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
