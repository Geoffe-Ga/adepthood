import type { NavigatorScreenParams } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import SharePreviewScreen from '../features/Practice/screens/SharePreviewScreen';
import ApiKeySettingsScreen from '../features/Settings/ApiKeySettingsScreen';

import type { RootTabParamList } from './BottomTabs';
import BottomTabs from './BottomTabs';

/**
 * Root stack for the authenticated app. Hosts the bottom-tabs shell plus
 * modal-style screens (e.g. BYOK API key settings, the practice share
 * preview screen deep-linked from another app) that should not live
 * inside any single tab.
 *
 * ``Tabs`` is typed as ``NavigatorScreenParams<RootTabParamList>`` (not
 * ``undefined``) so screens nested under it -- e.g. ``SharePreviewScreen``
 * forwarding the recipient back to the Practice tab after a successful
 * import -- can pass ``{ screen, params }`` through ``navigation.navigate``
 * with full type safety.
 */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<RootTabParamList>;
  ApiKeySettings: undefined;
  SharePreview: { token: string };
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
    <Stack.Screen
      name="SharePreview"
      component={SharePreviewScreen}
      options={{ title: 'Shared practice' }}
    />
  </Stack.Navigator>
);

export default RootStack;
