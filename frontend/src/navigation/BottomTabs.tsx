// frontend/navigation/BottomTabs.tsx

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React from 'react';

import CourseScreen from '../features/Course/CourseScreen';
import HabitsScreen from '../features/Habits/HabitsScreen';
import JournalScreen from '../features/Journal/JournalScreen';
import MapScreen from '../features/Map/MapScreen';
import PracticeScreen from '../features/Practice/PracticeScreen';

export type RootTabParamList = {
  Habits: undefined;
  Practice: undefined;
  Course: undefined;
  Journal: undefined;
  Map: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

/**
 * Application-wide bottom tab navigation.
 * Each tab corresponds to a major feature area.
 */
const BottomTabs = (): React.JSX.Element => {
  return (
    <Tab.Navigator initialRouteName="Habits">
      <Tab.Screen name="Habits" component={HabitsScreen} />
      <Tab.Screen name="Practice" component={PracticeScreen} />
      <Tab.Screen name="Course" component={CourseScreen} />
      <Tab.Screen name="Journal" component={JournalScreen} />
      <Tab.Screen name="Map" component={MapScreen} />
    </Tab.Navigator>
  );
};

export default BottomTabs;
