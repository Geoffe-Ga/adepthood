// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Settings } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';

import { FeatureErrorBoundary } from '../components/FeatureErrorBoundary';
import { accent, SPACING, touchTarget } from '../design/tokens';
import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalShelfScreen from '../features/Journal/JournalShelfScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';

import { NAV_DESTINATIONS, type NavDestination } from './destinations';
import type { RootStackParamList } from './RootStack';

import { useAuth } from '@/context/AuthContext';
import {
  load,
  selectEnableCourse,
  selectEnableHabits,
  selectEnablePractices,
  useDepthPreferencesStore,
} from '@/store/useDepthPreferencesStore';

export type RootTabParamList = {
  Habits: undefined;
  Practice: { stageNumber?: number } | undefined;
  // contentId/scrollOffset are optional restore hints from a Back-to-reading return.
  Course: { stageNumber?: number; contentId?: number; scrollOffset?: number } | undefined;
  Journal: undefined;
  Map: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

/**
 * Wrap a screen component in a ``FeatureErrorBoundary`` so a render crash in
 * one tab leaves the others usable (BUG-FRONTEND-INFRA-019).
 */
function withBoundary<P extends object>(
  name: string,
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  const Wrapped: React.ComponentType<P> = (props) => (
    <FeatureErrorBoundary name={name}>
      <Component {...props} />
    </FeatureErrorBoundary>
  );
  Wrapped.displayName = `Boundary(${name})`;
  return Wrapped;
}

const HabitsTab = withBoundary('Habits', HabitsScreen);
const PracticeTab = withBoundary('Practice', PracticeScreen);
const CourseTab = withBoundary('Course', CourseScreen);
const JournalTab = withBoundary('Journal', JournalShelfScreen);
const MapTab = withBoundary('Map', MapScreen);

const SETTINGS_ICON_SIZE = 24;

/** The single screen-component mapping, keyed by route so registry lookup is total. */
const SCREEN_COMPONENT_BY_NAME: Readonly<
  Record<keyof RootTabParamList, React.ComponentType<object>>
> = {
  Journal: JournalTab,
  Habits: HabitsTab,
  Practice: PracticeTab,
  Course: CourseTab,
  Map: MapTab,
};

/** Which depth-ring flag each optional route depends on, keyed for the enable map. */
type RingKey = 'habits' | 'practices' | 'course';

/** Route name of the always-present home the redirect falls back to. */
const REDIRECT_TARGET = 'Journal' as const;

/** Ring flag that governs each ring route, for the focus-redirect lookup. */
const RING_FLAG_BY_ROUTE: Readonly<Record<string, RingKey>> = {
  Habits: 'habits',
  Practice: 'practices',
  Course: 'course',
};

/** Live snapshot of the three ring flags, keyed to match the registry rings. */
type RingEnabledMap = Record<RingKey, boolean>;

/**
 * Subscribe to the three ring toggles and derive the visible destination list
 * from ``NAV_DESTINATIONS``, dropping any ring-gated route whose flag is off.
 * The registry fixes the order ``[Journal, Habits, Practice, Course, Map]``.
 * Reactive: a store flip re-renders the caller with the route added or removed.
 */
const useVisibleDestinations = (): {
  destinations: ReadonlyArray<NavDestination>;
  enabled: RingEnabledMap;
} => {
  const enabled: RingEnabledMap = {
    habits: useDepthPreferencesStore(selectEnableHabits),
    practices: useDepthPreferencesStore(selectEnablePractices),
    course: useDepthPreferencesStore(selectEnableCourse),
  };

  const destinations = NAV_DESTINATIONS.filter(
    (destination) => destination.ring === undefined || enabled[destination.ring],
  );

  return { destinations, enabled };
};

/**
 * When the focused tab is a ring whose flag just flipped off, redirect focus to
 * the always-present Journal so its screen — removed in the same store-driven
 * render — is never left as the active route. Depends on the live flags so the
 * effect re-runs the instant a ring is disabled.
 *
 * Reads the focused route and navigation from the tab navigator's own ``tabBar``
 * props — this hook runs INSIDE ``Tab.Navigator``, so ``props.navigation`` is the
 * tab navigator's helper (not the parent stack's), and no ``useNavigationState``
 * hook is needed. Placing it at the ``BottomTabs`` top level would read the parent
 * stack instead, or throw when no navigator sits above.
 */
const useRingRedirect = (props: BottomTabBarProps, enabled: RingEnabledMap): void => {
  const focusedRouteName = props.state.routes[props.state.index]?.name;
  const { navigation } = props;
  const { habits, practices, course } = enabled;

  React.useEffect(() => {
    const ringKey = focusedRouteName ? RING_FLAG_BY_ROUTE[focusedRouteName] : undefined;
    const flags: RingEnabledMap = { habits, practices, course };
    if (ringKey && !flags[ringKey]) {
      navigation.navigate(REDIRECT_TARGET);
    }
  }, [focusedRouteName, habits, practices, course, navigation]);
};

/**
 * Ring focus-redirect host, mounted via ``Tab.Navigator``'s ``tabBar`` prop so it
 * lives inside the navigator and can read the focused route from ``props.state``.
 * Renders nothing — the drawer is primary navigation, so no bar is drawn and no
 * bar height is reserved — while the redirect effect stays mounted.
 */
const RingAwareTabBar = (props: BottomTabBarProps & { enabled: RingEnabledMap }): null => {
  const { enabled, ...tabBarProps } = props;
  useRingRedirect(tabBarProps, enabled);
  return null;
};

/** Fetch the current ring toggles once on mount, keyed off the auth token. */
const useLoadDepthPreferences = (): void => {
  const { token } = useAuth();

  React.useEffect(() => {
    if (token) void load(token);
  }, [token]);
};

interface TabHeaderRightProps {
  onSettings: () => void;
}

/** Header-right gear that opens the Settings hub (#835), hoisted to a stable
 * component so it is not redefined on every ``BottomTabs`` render. Logout now
 * lives inside the hub's Session group, not on the tab header. */
const TabHeaderRight = ({ onSettings }: TabHeaderRightProps): React.JSX.Element => (
  <TouchableOpacity
    onPress={onSettings}
    style={styles.headerButton}
    accessibilityLabel="Open settings"
    accessibilityRole="button"
    testID="open-settings-button"
  >
    <Settings color={accent.primary} size={SETTINGS_ICON_SIZE} />
  </TouchableOpacity>
);

/**
 * Application-wide navigation shell. The drawer is the primary way to move
 * between feature areas, so this navigator draws no bottom bar; it hosts the
 * registry-derived screens and the header Settings gear.
 */
const BottomTabs = (): React.JSX.Element => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { destinations, enabled } = useVisibleDestinations();

  useLoadDepthPreferences();

  const openSettings = React.useCallback(() => {
    navigation.navigate('Settings');
  }, [navigation]);

  const renderHeaderRight = React.useCallback(
    () => <TabHeaderRight onSettings={openSettings} />,
    [openSettings],
  );

  const renderTabBar = React.useCallback(
    (props: BottomTabBarProps) => <RingAwareTabBar {...props} enabled={enabled} />,
    [enabled],
  );

  return (
    <Tab.Navigator
      initialRouteName={REDIRECT_TARGET}
      tabBar={renderTabBar}
      screenOptions={{ headerRight: renderHeaderRight }}
    >
      {destinations.map(({ name }) => (
        <Tab.Screen key={name} name={name} component={SCREEN_COMPONENT_BY_NAME[name]} />
      ))}
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  headerButton: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
});

export default BottomTabs;
