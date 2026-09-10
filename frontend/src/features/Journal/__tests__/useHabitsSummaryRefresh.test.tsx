/**
 * The journal shelf's "Today's habits" tile, refreshed the two ways it needs.
 *
 * The shelf stays mounted once visited, so its habit read happened exactly
 * once ever — it neither saw a check-in made elsewhere nor noticed the day
 * turning over. Entries and the weekly prompt were given a focus effect in
 * #2358; habits were not, and no one owned the day boundary at all (#2764).
 *
 * The focus half runs against a real navigator, so the fix is judged by the
 * navigator's own event ordering rather than by a stub's. The rollover half
 * needs no navigator: it is the shared day-boundary owner firing, and asserting
 * it on a bare `renderHook` keeps the claim "this re-rendered with nothing
 * remounting it" free of any navigation machinery that might have remounted it.
 */
import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { render, renderHook, act } from '@testing-library/react-native';
import React from 'react';
import { AppState, Text } from 'react-native';
import type { NativeEventSubscription } from 'react-native';

/** The zone `useAuth` is hydrated with for the test in flight. */
let mockHydratedTimezone = 'UTC';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: mockHydratedTimezone }),
}));

const mockLoadHabits = jest.fn();
jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    loadHabits: (...args: unknown[]) => mockLoadHabits(...args),
  },
}));

import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitsSummary } from '@/features/Journal/useHabitsSummary';
import { useHabitStore } from '@/store/useHabitStore';

const WEST_TZ = 'America/Los_Angeles';
const EAST_TZ = 'Asia/Tokyo';
/** 2026-02-10 23:50 in Los Angeles. */
const WEST_BEFORE_MIDNIGHT = new Date('2026-02-11T07:50:00.000Z').getTime();
/** 2026-02-11 23:50 in Tokyo. */
const EAST_BEFORE_MIDNIGHT = new Date('2026-02-11T14:50:00.000Z').getTime();
const TEN_MINUTES_MS = 600_000;

const habitCompletedAt = (completedAt: string): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Sit',
  icon: '🧘',
  streak: 1,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [],
  completions: [{ id: 'c-1', timestamp: new Date(completedAt), completed_units: 1 }],
  revealed: true,
});

interface Probe {
  doneCount: () => number;
  mounts: () => number;
  renders: () => number;
}

const mountSummary = (): Probe => {
  let mounts = 0;
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return useHabitsSummary();
  });
  return {
    doneCount: () => result.current.doneCount,
    mounts: () => mounts,
    renders: () => renders,
  };
};

type TabList = { Shelf: undefined; Elsewhere: undefined };
const Tabs = createBottomTabNavigator<TabList>();
const navigationRef = createNavigationContainerRef<TabList>();

const ShelfTab = (): React.JSX.Element => {
  useHabitsSummary();
  return <Text testID="shelf">Shelf</Text>;
};

const Elsewhere = (): React.JSX.Element => <Text testID="elsewhere">Elsewhere</Text>;

const mountShelfInNavigator = (): void => {
  render(
    <NavigationContainer ref={navigationRef}>
      <Tabs.Navigator screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="Shelf" component={ShelfTab} />
        <Tabs.Screen name="Elsewhere" component={Elsewhere} />
      </Tabs.Navigator>
    </NavigationContainer>,
  );
};

const goTo = (screen: keyof TabList): void => {
  act(() => {
    navigationRef.navigate(screen);
  });
};

describe('useHabitsSummary refresh', () => {
  beforeEach(() => {
    mockHydratedTimezone = 'UTC';
    mockLoadHabits.mockClear();
    useHabitStore.setState({ loading: false, habits: [], habitsById: {}, habitOrder: [] });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove: () => undefined }) as NativeEventSubscription);
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Ahead of the root-level fake-timer drain in `jest.setup.js`.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('coming back to the shelf', () => {
    it('reads habits again on return, not only on mount', () => {
      mockHydratedTimezone = WEST_TZ;
      mountShelfInNavigator();
      expect(mockLoadHabits).toHaveBeenCalledTimes(1);

      goTo('Elsewhere');
      goTo('Shelf');

      expect(mockLoadHabits).toHaveBeenCalledTimes(2);
    });

    it('does not read again merely for arriving somewhere else', () => {
      mockHydratedTimezone = WEST_TZ;
      mountShelfInNavigator();

      goTo('Elsewhere');

      expect(mockLoadHabits).toHaveBeenCalledTimes(1);
    });

    it('threads the auth-hydrated zone through every read', () => {
      mockHydratedTimezone = EAST_TZ;
      mountShelfInNavigator();

      goTo('Elsewhere');
      goTo('Shelf');

      expect(mockLoadHabits.mock.calls).toEqual([['Asia/Tokyo'], ['Asia/Tokyo']]);
    });
  });

  describe('the day turning over underneath it', () => {
    it('returns the done-count to zero at local midnight, without a remount', () => {
      mockHydratedTimezone = WEST_TZ;
      jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
      useHabitStore.setState({ habits: [habitCompletedAt('2026-02-11T07:30:00.000Z')] });
      const probe = mountSummary();
      expect(probe.doneCount()).toBe(1);
      const rendersBefore = probe.renders();

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      expect(probe.doneCount()).toBe(0);
      expect(probe.mounts()).toBe(1);
      expect(probe.renders()).toBeGreaterThan(rendersBefore);
    });

    it('holds the count until the boundary actually arrives', () => {
      mockHydratedTimezone = WEST_TZ;
      jest.setSystemTime(WEST_BEFORE_MIDNIGHT);
      useHabitStore.setState({ habits: [habitCompletedAt('2026-02-11T07:30:00.000Z')] });
      const probe = mountSummary();

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS - 60_000);
      });

      expect(probe.doneCount()).toBe(1);
    });

    it('turns over at the user zone east of UTC, not at UTC midnight', () => {
      mockHydratedTimezone = EAST_TZ;
      jest.setSystemTime(EAST_BEFORE_MIDNIGHT);
      useHabitStore.setState({ habits: [habitCompletedAt('2026-02-11T14:30:00.000Z')] });
      const probe = mountSummary();
      expect(probe.doneCount()).toBe(1);

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      expect(probe.doneCount()).toBe(0);
      expect(probe.mounts()).toBe(1);
    });

    it('leaves a habit completed after the boundary counted', () => {
      // Logged at 00:05 on the 11th in Los Angeles: today, not last night. The
      // rollover must not sweep the count to zero indiscriminately.
      mockHydratedTimezone = WEST_TZ;
      jest.setSystemTime(new Date('2026-02-11T08:20:00.000Z').getTime());
      useHabitStore.setState({ habits: [habitCompletedAt('2026-02-11T08:05:00.000Z')] });
      const probe = mountSummary();

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      expect(probe.doneCount()).toBe(1);
    });
  });
});
