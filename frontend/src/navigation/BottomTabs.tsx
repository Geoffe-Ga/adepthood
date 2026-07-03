// frontend/navigation/BottomTabs.tsx

import {
  BottomTabBar,
  createBottomTabNavigator,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  BookOpen,
  Compass,
  Flower2,
  NotebookPen,
  Settings,
  Sprout,
  type LucideIcon,
} from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';

import type { JournalTag } from '../api';
import { FeatureErrorBoundary } from '../components/FeatureErrorBoundary';
import { accent, ink, SPACING, surface, touchTarget } from '../design/tokens';
import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalShelfScreen from '../features/Journal/JournalShelfScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';

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
  Course: { stageNumber?: number } | undefined;
  Journal:
    | {
        tag?: JournalTag;
        stageNumber?: number;
        contentTitle?: string;
        practiceSessionId?: number;
        userPracticeId?: number;
        practiceName?: string;
        practiceDuration?: number;
      }
    | undefined;
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

const TAB_ICON_SIZE = 24;
const TAB_ICON_STROKE = 2;
const SETTINGS_ICON_SIZE = 24;

/** Returns a tab-bar icon renderer with shared size/stroke for every entry. */
const makeTabIcon =
  (Icon: LucideIcon) =>
  ({ color }: { color: string }): React.JSX.Element => (
    <Icon color={color} size={TAB_ICON_SIZE} strokeWidth={TAB_ICON_STROKE} />
  );

type TabConfig = {
  name: keyof RootTabParamList;
  component: React.ComponentType<object>;
  icon: LucideIcon;
};

/** Which depth-ring flag each optional tab depends on, keyed for the enable map. */
type RingKey = 'habits' | 'practices' | 'course';

/** The three ring tabs, in the fixed order they slot between Journal and Map. */
const RING_TABS: ReadonlyArray<{ key: RingKey; config: TabConfig }> = [
  { key: 'habits', config: { name: 'Habits', component: HabitsTab, icon: Sprout } },
  { key: 'practices', config: { name: 'Practice', component: PracticeTab, icon: Flower2 } },
  { key: 'course', config: { name: 'Course', component: CourseTab, icon: BookOpen } },
];

/** Journal always leads; Map always trails — neither is ring-gated. */
const LEADING_TABS: ReadonlyArray<TabConfig> = [
  { name: 'Journal', component: JournalTab, icon: NotebookPen },
];
const TRAILING_TABS: ReadonlyArray<TabConfig> = [{ name: 'Map', component: MapTab, icon: Compass }];

/** Route name of the always-present home the redirect falls back to. */
const REDIRECT_TARGET = 'Journal' as const;

/** Ring flag that governs each ring route, for the focus-redirect lookup. */
const RING_FLAG_BY_ROUTE: Readonly<Record<string, RingKey>> = {
  Habits: 'habits',
  Practice: 'practices',
  Course: 'course',
};

/** Live snapshot of the three ring flags, keyed to match ``RING_TABS``. */
type RingEnabledMap = Record<RingKey, boolean>;

/**
 * Subscribe to the three ring toggles and assemble the visible tab list in the
 * fixed order ``[Journal, ...enabledRings, Map]``. Reactive: a store flip
 * re-renders the caller with the tab added or removed live.
 */
const useEnabledTabs = (): { tabs: ReadonlyArray<TabConfig>; enabled: RingEnabledMap } => {
  const enabled: RingEnabledMap = {
    habits: useDepthPreferencesStore(selectEnableHabits),
    practices: useDepthPreferencesStore(selectEnablePractices),
    course: useDepthPreferencesStore(selectEnableCourse),
  };

  const enabledRings = RING_TABS.filter((ring) => enabled[ring.key]).map((ring) => ring.config);
  const tabs = [...LEADING_TABS, ...enabledRings, ...TRAILING_TABS];

  return { tabs, enabled };
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
 * The default bottom tab bar, augmented with the ring focus-redirect. Rendered
 * via ``Tab.Navigator``'s ``tabBar`` prop so it lives inside the navigator and
 * can read the tab navigator's focused route straight from ``props.state``.
 */
const RingAwareTabBar = (
  props: BottomTabBarProps & { enabled: RingEnabledMap },
): React.JSX.Element => {
  const { enabled, ...tabBarProps } = props;
  useRingRedirect(tabBarProps, enabled);
  return <BottomTabBar {...tabBarProps} />;
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
 * Application-wide bottom tab navigation.
 * Each tab corresponds to a major feature area.
 */
const BottomTabs = (): React.JSX.Element => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { tabs, enabled } = useEnabledTabs();

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
      screenOptions={{
        // Warm tab bar (#803): raised paper ground + hairline top edge; active
        // terracotta vs muted ink, both AA on the raised ground.
        tabBarActiveTintColor: accent.primary,
        tabBarInactiveTintColor: ink.muted,
        // borderTopWidth is intentionally omitted — RN Navigation defaults it to
        // StyleSheet.hairlineWidth; we only retint the existing edge.
        tabBarStyle: { backgroundColor: surface.raised, borderTopColor: surface.hairline },
        headerRight: renderHeaderRight,
      }}
    >
      {tabs.map(({ name, component, icon }) => (
        <Tab.Screen
          key={name}
          name={name}
          component={component}
          options={{ tabBarIcon: makeTabIcon(icon) }}
        />
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
