// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import type { JournalTag } from '../api';
import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalScreen from '../features/Journal/JournalScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';

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
 * Application-wide bottom tab navigation.
 * Each tab corresponds to a major feature area.
 */
const BottomTabs = (): React.JSX.Element => {
  const { logout } = useAuth();

  return (
    <Tab.Navigator
      initialRouteName="Habits"
      screenOptions={{
        headerRight: () => (
          <TouchableOpacity onPress={logout} style={styles.logoutButton}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        ),
      }}
    >
      <Tab.Screen name="Habits" component={HabitsScreen} />
      <Tab.Screen name="Practice" component={PracticeScreen} />
      <Tab.Screen name="Course" component={CourseScreen} />
      <Tab.Screen name="Journal" component={JournalScreen} />
      <Tab.Screen name="Map" component={MapScreen} />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  logoutButton: { marginRight: 12 },
  logoutText: { color: '#4a90d9', fontSize: 14, fontWeight: '600' },
});

export default BottomTabs;
