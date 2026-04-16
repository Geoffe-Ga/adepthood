// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { JournalTag } from '../api';
import { FeatureErrorBoundary } from '../components/FeatureErrorBoundary';
import { colors, SPACING } from '../design/tokens';
import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalScreen from '../features/Journal/JournalScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';

import type { RootStackParamList } from './RootStack';

import { useAuth } from '@/context/AuthContext';

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
const JournalTab = withBoundary('Journal', JournalScreen);
const MapTab = withBoundary('Map', MapScreen);

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

  return (
    <Tab.Navigator
      initialRouteName="Habits"
      screenOptions={{
        headerRight: () => (
          <View style={styles.headerRight}>
            <TouchableOpacity
              onPress={openSettings}
              style={styles.headerButton}
              accessibilityLabel="Open settings"
              accessibilityRole="button"
              testID="open-settings-button"
            >
              <Text style={styles.headerButtonText}>⚙︎</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={logout}
              style={styles.headerButton}
              accessibilityLabel="Log out"
              accessibilityRole="button"
              testID="logout-button"
            >
              <Text style={styles.headerButtonText}>Logout</Text>
            </TouchableOpacity>
          </View>
        ),
      }}
    >
      <Tab.Screen name="Habits" component={HabitsTab} />
      <Tab.Screen name="Practice" component={PracticeTab} />
      <Tab.Screen name="Course" component={CourseTab} />
      <Tab.Screen name="Journal" component={JournalTab} />
      <Tab.Screen name="Map" component={MapTab} />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', marginRight: SPACING.sm },
  headerButton: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  headerButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
});

export default BottomTabs;
