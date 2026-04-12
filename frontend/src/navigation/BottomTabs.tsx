// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { JournalTag } from '../api';
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
              testID="open-settings-button"
            >
              <Text style={styles.headerButtonText}>⚙︎</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={logout} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Logout</Text>
            </TouchableOpacity>
          </View>
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
  headerRight: { flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  headerButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerButtonText: { color: '#4a90d9', fontSize: 14, fontWeight: '600' },
});

export default BottomTabs;
