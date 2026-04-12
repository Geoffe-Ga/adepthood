import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import ApiKeySettingsScreen from '../features/Settings/ApiKeySettingsScreen';

import BottomTabs from './BottomTabs';

/**
 * Root stack for the authenticated app. Hosts the bottom-tabs shell plus
 * modal-style screens (e.g. BYOK API key settings) that should not live
 * inside any single tab.
 */
export type RootStackParamList = {
  Tabs: undefined;
  ApiKeySettings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const RootStack = (): React.JSX.Element => (
  <Stack.Navigator>
    <Stack.Screen name="Tabs" component={BottomTabs} options={{ headerShown: false }} />
    <Stack.Screen
      name="ApiKeySettings"
      component={ApiKeySettingsScreen}
      options={{ title: 'API Key' }}
    />
  </Stack.Navigator>
);

export default RootStack;
