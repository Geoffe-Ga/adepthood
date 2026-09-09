/**
 * Re-reading on focus, proved against a real navigator.
 *
 * A tab that has been visited once stays mounted, so a `useEffect` keyed on
 * anything stable runs exactly once ever and the screen shows whatever it
 * fetched the first time it was opened (#2764). The fix has to fire on the
 * *return*, and only on the return: a hook that also fired for the focus a
 * screen mounts with would double every cold-start fetch.
 *
 * These tests drive an actual `NavigationContainer` and an actual bottom-tab
 * navigator rather than a stubbed `useFocusEffect`, because the two failure
 * modes that matter — a duplicate initial fire, and a return that is missed
 * because the screen was already considered focused — are properties of the
 * navigator's own event ordering. A stub decides that ordering by fiat and
 * would agree with whatever the hook happened to do.
 */
import { jest, describe, expect, it, beforeEach } from '@jest/globals';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  NavigationContainer,
  NavigationContext,
  createNavigationContainerRef,
} from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { render, renderHook, act } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { useRefetchOnFocus } from '../useRefetchOnFocus';

type TabList = { First: undefined; Second: undefined };

const Tabs = createBottomTabNavigator<TabList>();
const navigationRef = createNavigationContainerRef<TabList>();

/** Calls recorded by the screen under test, in order. */
let refetches: string[] = [];

const FirstScreen = (): React.JSX.Element => {
  useRefetchOnFocus(React.useCallback(() => refetches.push('first'), []));
  return <Text testID="first">First</Text>;
};

const SecondScreen = (): React.JSX.Element => {
  useRefetchOnFocus(React.useCallback(() => refetches.push('second'), []));
  return <Text testID="second">Second</Text>;
};

const mountTabs = (): void => {
  render(
    <NavigationContainer ref={navigationRef}>
      <Tabs.Navigator screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="First" component={FirstScreen} />
        <Tabs.Screen name="Second" component={SecondScreen} />
      </Tabs.Navigator>
    </NavigationContainer>,
  );
};

const goTo = (screen: keyof TabList): void => {
  act(() => {
    navigationRef.navigate(screen);
  });
};

describe('useRefetchOnFocus', () => {
  beforeEach(() => {
    refetches = [];
  });

  it('stays quiet for the focus a screen mounts with', () => {
    mountTabs();

    // The mount-time fetch is the caller's own effect; firing here as well
    // would make every cold open request twice.
    expect(refetches).toEqual([]);
  });

  it('fires when a tab left behind is returned to', () => {
    mountTabs();

    goTo('Second');
    goTo('First');

    expect(refetches).toEqual(['first']);
  });

  it('fires once per return, not once per render while focused', () => {
    mountTabs();

    // First is focused at mount and Second mounts on its own first arrival, so
    // neither of those two focuses is a return. Everything after is.
    goTo('Second');
    goTo('First');
    goTo('Second');
    goTo('First');

    expect(refetches).toEqual(['first', 'second', 'first']);
  });

  it('does not fire for a screen while it is the one being left', () => {
    mountTabs();

    goTo('Second');

    // Second mounted on arrival, so its own focus is an initial one; First was
    // blurred, not focused. Neither should have re-read.
    expect(refetches).toEqual([]);
  });

  it('fires for whichever tab is arrived at, each on its own return', () => {
    mountTabs();

    goTo('Second');
    goTo('First');
    goTo('Second');

    expect(refetches).toEqual(['first', 'second']);
  });

  it('runs the callback the caller passed most recently, not the first one', () => {
    const calls: string[] = [];
    const Screen = ({ label }: { label: string }): React.JSX.Element => {
      // Deliberately a fresh closure each render, capturing the current label:
      // a hook that re-subscribed on every render would still pass this, but
      // one that captured the mount-time closure forever would refetch with a
      // stale timezone, which is exactly the argument being threaded through.
      useRefetchOnFocus(() => calls.push(label));
      return <Text>{label}</Text>;
    };
    const tree = render(
      <NavigationContainer ref={navigationRef}>
        <Tabs.Navigator screenOptions={{ headerShown: false }}>
          <Tabs.Screen name="First">{() => <Screen label="before" />}</Tabs.Screen>
          <Tabs.Screen name="Second" component={SecondScreen} />
        </Tabs.Navigator>
      </NavigationContainer>,
    );
    goTo('Second');
    tree.rerender(
      <NavigationContainer ref={navigationRef}>
        <Tabs.Navigator screenOptions={{ headerShown: false }}>
          <Tabs.Screen name="First">{() => <Screen label="after" />}</Tabs.Screen>
          <Tabs.Screen name="Second" component={SecondScreen} />
        </Tabs.Navigator>
      </NavigationContainer>,
    );

    goTo('First');

    expect(calls).toEqual(['after']);
  });

  it('is inert rather than fatal outside a navigator', () => {
    // Every data hook that uses this is also exercised bare in unit tests, and
    // `useFocusEffect` throws there because it goes through `useNavigation`.
    // Reading the context directly means "no navigator" is a legible state —
    // there are no focus events to miss — instead of a crash.
    const bare = jest.fn();

    expect(() => renderHook(() => useRefetchOnFocus(bare))).not.toThrow();
    expect(bare).not.toHaveBeenCalled();
  });

  it('releases both navigation listeners when the screen unmounts', () => {
    // A real tab navigator keeps its screens mounted, which is the premise of
    // the bug and therefore no place to observe teardown. A hand-built
    // navigation object is: the claim under test is narrow and mechanical —
    // every listener this hook adds is one it later removes, so nothing fires
    // into a torn-down tree.
    const removals: string[] = [];
    const listeners: string[] = [];
    const navigation = {
      isFocused: () => true,
      addListener: (event: string) => {
        listeners.push(event);
        return () => removals.push(event);
      },
    } as unknown as NavigationProp<ParamListBase>;

    const { unmount } = renderHook(() => useRefetchOnFocus(() => undefined), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>
      ),
    });
    expect(listeners.sort()).toEqual(['blur', 'focus']);
    expect(removals).toEqual([]);

    unmount();

    expect(removals.sort()).toEqual(['blur', 'focus']);
  });
});
