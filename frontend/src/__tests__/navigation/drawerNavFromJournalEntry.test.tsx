// Real NavigationContainer/stack/tabs harness (no navigation mocks) proving the
// drawer's nav rows work when hosted from a root-stack screen, not just a tab.
import { beforeEach, describe, expect, it } from '@jest/globals';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NavigatorScreenParams } from '@react-navigation/native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import DrawerNavSection from '@/components/drawer/DrawerNavSection';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

type TestStackParamList = {
  Tabs: NavigatorScreenParams<RootTabParamList>;
  JournalEntry: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<TestStackParamList>();

function JournalScreenStub(): React.JSX.Element {
  return <Text>Journal screen stub</Text>;
}

function HabitsScreenStub(): React.JSX.Element {
  return <Text>Habits screen stub</Text>;
}

function PracticeScreenStub(): React.JSX.Element {
  return <Text>Practice screen stub</Text>;
}

function CourseScreenStub(): React.JSX.Element {
  return <Text>Course screen stub</Text>;
}

function MapScreenStub(): React.JSX.Element {
  return <Text>Map screen stub</Text>;
}

function TestTabs(): React.JSX.Element {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Journal" component={JournalScreenStub} />
      <Tab.Screen name="Habits" component={HabitsScreenStub} />
      <Tab.Screen name="Practice" component={PracticeScreenStub} />
      <Tab.Screen name="Course" component={CourseScreenStub} />
      <Tab.Screen name="Map" component={MapScreenStub} />
    </Tab.Navigator>
  );
}

function JournalEntryHost(): React.JSX.Element {
  return <DrawerNavSection currentScreen="Journal" onNavigate={() => undefined} />;
}

function TestRootNavigator(): React.JSX.Element {
  return (
    <Stack.Navigator initialRouteName="JournalEntry" screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={TestTabs} />
      <Stack.Screen name="JournalEntry" component={JournalEntryHost} />
    </Stack.Navigator>
  );
}

function renderFromJournalEntry() {
  return render(
    <NavigationContainer>
      <TestRootNavigator />
    </NavigationContainer>,
  );
}

beforeEach(() => {
  useDepthPreferencesStore.setState({
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
  });
});

describe('drawer nav rows from a root-stack screen (JournalEntry)', () => {
  it('tapping Map navigates to the Map tab even when the drawer is hosted from JournalEntry', async () => {
    const { getByTestId, getByText } = renderFromJournalEntry();

    fireEvent.press(getByTestId('drawer-nav-Map'));

    await waitFor(() => expect(getByText('Map screen stub')).toBeTruthy());
  });

  it('tapping Journal navigates to the Journal tab from JournalEntry', async () => {
    const { getByTestId, getByText } = renderFromJournalEntry();

    fireEvent.press(getByTestId('drawer-nav-Journal'));

    await waitFor(() => expect(getByText('Journal screen stub')).toBeTruthy());
  });
});
