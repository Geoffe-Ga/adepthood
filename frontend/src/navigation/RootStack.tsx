import type { NavigatorScreenParams } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import JournalEntryScreen from '../features/Journal/JournalEntryScreen';
import JournalPhotographScreen from '../features/Journal/JournalPhotographScreen';
import { CreatePracticeWizard } from '../features/Practice/screens/CreatePracticeWizard';
import { PracticeCatalogScreen } from '../features/Practice/screens/PracticeCatalogScreen';
import { PracticeDetailScreen } from '../features/Practice/screens/PracticeDetailScreen';
import SharePreviewScreen from '../features/Practice/screens/SharePreviewScreen';
import ApiKeySettingsScreen from '../features/Settings/ApiKeySettingsScreen';
import SettingsHubScreen from '../features/Settings/SettingsHubScreen';
import SupportCareScreen from '../features/Settings/SupportCareScreen';
import TimezoneSettingsScreen from '../features/Settings/TimezoneSettingsScreen';

import type { RootTabParamList } from './BottomTabs';
import BottomTabs from './BottomTabs';

import type { ReflectionLevel } from '@/api';
import { accent, fonts, ink } from '@/design/tokens';
import type { ModeConfig } from '@/features/Practice/engine/types';

export interface CreatePracticePrefill {
  config: ModeConfig;
  name?: string;
  description?: string;
  instructions?: string;
  duration?: number;
  stageNumber?: number | null;
}

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<RootTabParamList>;
  Settings: undefined;
  ApiKeySettings: undefined;
  TimezoneSettings: undefined;
  SupportCare: undefined;
  SharePreview: { token: string };
  PracticeDetail: { practiceId: number; assignError?: string };
  CreatePractice: { prefill?: CreatePracticePrefill } | undefined;
  Catalog: { stageNumber?: number } | undefined;
  JournalPhotograph: undefined;
  JournalEntry:
    | {
        entryId?: number;
        /** Set when arriving fresh from photograph capture: reads as "Saved" and
         *  offers resonance immediately, skipping the usual idle-after-typing wait. */
        justSaved?: boolean;
        weekNumber?: number;
        promptQuestion?: string;
        practiceSessionId?: number;
        userPracticeId?: number;
        prefillTitle?: string;
        /** Reflection scope this page closes (7th-day reflection compose mode). */
        reflectionLevel?: ReflectionLevel;
        /** The scope key the reflection covers (e.g. ``c1:w14``); pairs with ``reflectionLevel``. */
        reflectionScopeKey?: string;
        /** A passage folded in from the reader; seeds the body as a blockquote. */
        prefillQuote?: { text: string; sourceTitle: string };
        /** Where "Back to reading" returns the writer, restoring their scroll. */
        returnTo?: {
          screen: 'Course';
          params: { stageNumber?: number; contentId: number; scrollOffset: number };
        };
      }
    | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Header background/border come from the warm navTheme; here we add the
// editorial serif title + terracotta back/tint.
const NAV_SCREEN_OPTIONS = {
  headerTintColor: accent.primary,
  headerTitleStyle: { fontFamily: fonts.serif, color: ink.primary },
} as const;

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
/** The Journal routes pushed as siblings of the tab shell: the entry editor and
 *  the photograph-capture flow. Grouped in a fragment to keep ``RootStack`` lean. */
const JournalScreens = (): React.JSX.Element => (
  <>
    <Stack.Screen
      name="JournalEntry"
      component={JournalEntryScreen}
      options={{ title: 'Journal' }}
    />
    <Stack.Screen
      name="JournalPhotograph"
      component={JournalPhotographScreen}
      options={{ title: 'Photograph journal' }}
    />
  </>
);

const RootStack = (): React.JSX.Element => (
  <Stack.Navigator screenOptions={NAV_SCREEN_OPTIONS}>
    <Stack.Screen name="Tabs" component={BottomTabs} options={{ headerShown: false }} />
    <Stack.Screen name="Settings" component={SettingsHubScreen} options={{ title: 'Settings' }} />
    <Stack.Screen
      name="ApiKeySettings"
      component={ApiKeySettingsScreen}
      options={{ title: 'API Key' }}
    />
    <Stack.Screen
      name="TimezoneSettings"
      component={TimezoneSettingsScreen}
      options={{ title: 'Time zone' }}
    />
    <Stack.Screen
      name="SupportCare"
      component={SupportCareScreen}
      options={{ title: 'Support & care' }}
    />
    <Stack.Screen
      name="SharePreview"
      component={SharePreviewScreen}
      options={{ title: 'Shared practice' }}
    />
    <Stack.Screen
      name="PracticeDetail"
      component={PracticeDetailScreen}
      options={{ title: 'Practice' }}
    />
    <Stack.Screen
      name="CreatePractice"
      component={CreatePracticeWizard}
      options={{ title: 'New practice' }}
    />
    <Stack.Screen
      name="Catalog"
      component={PracticeCatalogScreen}
      options={{ title: 'Practices' }}
    />
    {JournalScreens()}
  </Stack.Navigator>
);

export default RootStack;
