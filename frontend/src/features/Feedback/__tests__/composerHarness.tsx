/**
 * A real navigation tree for the composer: a root stack whose bottom route is a
 * tab shell (so the origin-route lookup walks the same shape it does in the app)
 * and whose top route is the composer, opened with whatever params a test gives.
 */
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import FeedbackComposerScreen from '@/features/Feedback/FeedbackComposerScreen';

type HarnessStack = {
  Tabs: undefined;
  Feedback: Record<string, unknown> | undefined;
};

const Stack = createNativeStackNavigator<HarnessStack>();
const Tab = createBottomTabNavigator();

function JournalStub(): React.JSX.Element {
  return <Text>Journal stub</Text>;
}

function TabsStub(): React.JSX.Element {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Journal" component={JournalStub} />
    </Tab.Navigator>
  );
}

export function renderComposer(params?: Record<string, unknown>): ReturnType<typeof render> {
  return render(
    <NavigationContainer
      initialState={{
        index: 1,
        routes: [
          {
            name: 'Tabs',
            state: {
              index: 0,
              routes: [{ name: 'Journal', params: { text: 'journal prose on screen' } }],
            },
          },
          { name: 'Feedback', params },
        ],
      }}
    >
      <Stack.Navigator>
        <Stack.Screen name="Tabs" component={TabsStub} />
        <Stack.Screen name="Feedback" component={FeedbackComposerScreen} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}
