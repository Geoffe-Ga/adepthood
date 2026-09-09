/**
 * The Habits tab, re-read when the user comes back to it.
 *
 * `useBootstrapHabits` loaded on mount and never again. React Navigation keeps
 * the tab mounted after its first visit, so a check-in accepted from the
 * journal, or anything else the server learned meanwhile, was invisible until
 * the app was restarted (#2764).
 *
 * The navigator here is real. A stubbed `useFocusEffect` would decide the
 * event ordering the fix depends on — whether the arrival a screen mounts for
 * counts as a return — by fiat, and so could not tell a correct hook from one
 * that fetches twice on every cold open.
 */
import { jest, describe, expect, it, beforeEach } from '@jest/globals';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { render, renderHook, act } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { useBootstrapHabits } from '../useHabits';

const mockLoadHabits = jest.fn();
jest.mock('../../services/habitManager', () => ({
  habitManager: {
    loadHabits: (...args: unknown[]) => mockLoadHabits(...args),
  },
}));

jest.mock('../useHabitNotifications', () => ({
  registerForPushNotificationsAsync: () => Promise.resolve(undefined),
  reconcileNotifications: () => Promise.resolve(),
}));

const WEST_TZ = 'America/Los_Angeles';
const EAST_TZ = 'Asia/Tokyo';

type TabList = { Habits: undefined; Elsewhere: undefined };
const Tabs = createBottomTabNavigator<TabList>();
const navigationRef = createNavigationContainerRef<TabList>();

/** The zone the enclosing auth context is hydrated with for the test in flight. */
let hydratedTimezone = 'UTC';

/** Stands in for auth hydrating a new zone into the mounted tab mid-session. */
let rehydrateZone: (_tz: string) => void = () => undefined;

const HabitsTab = (): React.JSX.Element => {
  const [tz, setTz] = React.useState(hydratedTimezone);
  rehydrateZone = setTz;
  useBootstrapHabits(tz);
  return <Text testID="habits">Habits</Text>;
};

const Elsewhere = (): React.JSX.Element => <Text testID="elsewhere">Elsewhere</Text>;

const mountTabs = (): void => {
  render(
    <NavigationContainer ref={navigationRef}>
      <Tabs.Navigator screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="Habits" component={HabitsTab} />
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

describe('useBootstrapHabits on focus', () => {
  beforeEach(() => {
    hydratedTimezone = WEST_TZ;
    mockLoadHabits.mockClear();
  });

  it('reads habits once on the visit that mounts the tab', () => {
    mountTabs();

    expect(mockLoadHabits).toHaveBeenCalledTimes(1);
  });

  it('reads them again when the user returns to the tab', () => {
    mountTabs();

    goTo('Elsewhere');
    goTo('Habits');

    expect(mockLoadHabits).toHaveBeenCalledTimes(2);
  });

  it('reads them again on every return, not just the first', () => {
    mountTabs();

    goTo('Elsewhere');
    goTo('Habits');
    goTo('Elsewhere');
    goTo('Habits');

    expect(mockLoadHabits).toHaveBeenCalledTimes(3);
  });

  it('does not read while the tab is the one being left', () => {
    mountTabs();

    goTo('Elsewhere');

    expect(mockLoadHabits).toHaveBeenCalledTimes(1);
  });

  it('threads the auth-hydrated zone, not the UTC default, through the refetch', () => {
    hydratedTimezone = EAST_TZ;
    mountTabs();

    goTo('Elsewhere');
    goTo('Habits');

    expect(mockLoadHabits.mock.calls).toEqual([['Asia/Tokyo'], ['Asia/Tokyo']]);
  });

  it('refetches with the zone that hydrated after mount, not the mount-time one', () => {
    // The cold-start double bootstrap (#269): the first pass runs on the UTC
    // default, auth then hydrates the real zone. A return after that must read
    // with the real zone, not with the closure the tab was mounted with.
    hydratedTimezone = 'UTC';
    mountTabs();
    act(() => {
      rehydrateZone(EAST_TZ);
    });
    expect(mockLoadHabits.mock.calls).toEqual([['UTC'], ['Asia/Tokyo']]);

    goTo('Elsewhere');
    goTo('Habits');

    // A third read, and in Tokyo: a hook that captured the mount-time callback
    // would have re-read the UTC default here and re-bucketed the shelf into
    // the wrong calendar day.
    expect(mockLoadHabits.mock.calls).toEqual([['UTC'], ['Asia/Tokyo'], ['Asia/Tokyo']]);
  });

  it('still loads on mount when there is no navigator at all', () => {
    // Guards the ~18 suites that exercise the habit hooks bare: absent a
    // navigator the focus path is inert, and the mount read must survive.
    renderHook(() => useBootstrapHabits(WEST_TZ));

    expect(mockLoadHabits).toHaveBeenCalledTimes(1);
  });
});
