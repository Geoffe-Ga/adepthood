// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  BookOpen,
  Compass,
  Flower2,
  Home,
  NotebookPen,
  Sprout,
  type LucideIcon,
} from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { JournalTag } from '../api';
import { FeatureErrorBoundary } from '../components/FeatureErrorBoundary';
import { accent, ink, SPACING, surface } from '../design/tokens';
import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalShelfScreen from '../features/Journal/JournalShelfScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';
import TodayScreen from '../features/Today/TodayScreen';

import type { RootStackParamList } from './RootStack';

import { useAuth } from '@/context/AuthContext';

export type RootTabParamList = {
  Today: undefined;
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

const TodayTab = withBoundary('Today', TodayScreen);
const HabitsTab = withBoundary('Habits', HabitsScreen);
const PracticeTab = withBoundary('Practice', PracticeScreen);
const CourseTab = withBoundary('Course', CourseScreen);
const JournalTab = withBoundary('Journal', JournalShelfScreen);
const MapTab = withBoundary('Map', MapScreen);

const TAB_ICON_SIZE = 24;
const TAB_ICON_STROKE = 2;

/** Returns a tab-bar icon renderer with shared size/stroke for every entry. */
const makeTabIcon =
  (Icon: LucideIcon) =>
  ({ color }: { color: string }): React.JSX.Element => (
    <Icon color={color} size={TAB_ICON_SIZE} strokeWidth={TAB_ICON_STROKE} />
  );

const TAB_CONFIGS: ReadonlyArray<{
  name: keyof RootTabParamList;
  component: React.ComponentType<object>;
  icon: LucideIcon;
}> = [
  { name: 'Today', component: TodayTab, icon: Home },
  { name: 'Habits', component: HabitsTab, icon: Sprout },
  { name: 'Practice', component: PracticeTab, icon: Flower2 },
  { name: 'Course', component: CourseTab, icon: BookOpen },
  { name: 'Journal', component: JournalTab, icon: NotebookPen },
  { name: 'Map', component: MapTab, icon: Compass },
];

interface TabHeaderRightProps {
  onSettings: () => void;
  onLogout: () => void;
}

/** Header actions (settings + logout), hoisted to a stable component so it is
 * not redefined on every ``BottomTabs`` render. */
const TabHeaderRight = ({ onSettings, onLogout }: TabHeaderRightProps): React.JSX.Element => (
  <View style={styles.headerRight}>
    <TouchableOpacity
      onPress={onSettings}
      style={styles.headerButton}
      accessibilityLabel="Open settings"
      accessibilityRole="button"
      testID="open-settings-button"
    >
      <Text style={styles.headerButtonText}>⚙︎</Text>
    </TouchableOpacity>
    <TouchableOpacity
      onPress={onLogout}
      style={styles.headerButton}
      accessibilityLabel="Log out"
      accessibilityRole="button"
      testID="logout-button"
    >
      <Text style={styles.headerButtonText}>Logout</Text>
    </TouchableOpacity>
  </View>
);

/**
 * Application-wide bottom tab navigation.
 * Each tab corresponds to a major feature area.
 */
const BottomTabs = (): React.JSX.Element => {
  const { logout } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const openSettings = React.useCallback(() => {
    navigation.navigate('ApiKeySettings');
  }, [navigation]);

  const renderHeaderRight = React.useCallback(
    () => <TabHeaderRight onSettings={openSettings} onLogout={logout} />,
    [openSettings, logout],
  );

  return (
    <Tab.Navigator
      initialRouteName="Today"
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
      {TAB_CONFIGS.map(({ name, component, icon }) => (
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
  headerRight: { flexDirection: 'row', alignItems: 'center', marginRight: SPACING.sm },
  headerButton: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  headerButtonText: { color: accent.primary, fontSize: 14, fontWeight: '600' },
});

export default BottomTabs;
