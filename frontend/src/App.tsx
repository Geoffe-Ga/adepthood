// frontend/src/App.tsx

import type { LinkingOptions, NavigatorScreenParams } from '@react-navigation/native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import {
  ActivityIndicator,
  Appearance,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ErrorBoundary } from './components/ErrorBoundary';
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary';
import { OfflineBanner } from './components/OfflineBanner';
import { ToastProvider } from './components/ToastProvider';
import { CONFIG_ERROR } from './config';
import { ApiKeyProvider } from './context/ApiKeyContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NetworkStatusProvider } from './context/NetworkStatusContext';
import { colors, SPACING } from './design/tokens';
import LoginScreen from './features/Auth/LoginScreen';
import SignupScreen from './features/Auth/SignupScreen';
import type { RootTabParamList } from './navigation/BottomTabs';
import type { RootStackParamList } from './navigation/RootStack';
import RootStack from './navigation/RootStack';

type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

/**
 * Deep linking configuration. Covers every top-level screen so that
 * ``adepthood://api-key-settings`` (BUG-FRONTEND-INFRA-008) — and future
 * modal routes — can land users exactly where they need to be, not just
 * inside the tab shell.
 */
type LinkedRootParamList = Omit<RootStackParamList, 'Tabs'> & {
  Tabs: NavigatorScreenParams<RootTabParamList>;
};

const linking: LinkingOptions<LinkedRootParamList> = {
  prefixes: ['adepthood://'],
  config: {
    screens: {
      Tabs: {
        screens: {
          Habits: 'habits',
          Practice: 'practice/:stageNumber?',
          Course: 'course/:stageNumber?',
          Journal: 'journal',
          Map: 'map',
        },
      },
      ApiKeySettings: 'api-key-settings', // pragma: allowlist secret
    },
  },
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
    </AuthStack.Navigator>
  );
}

/**
 * BUG-FRONTEND-INFRA-002 / 003 / 022 — keying the subtree on the auth state
 * forces a full remount on login/logout, which clears:
 *
 *   - Tab navigator state (selected tab, scroll offsets, pending navigation)
 *   - Route params carried over from a prior session (e.g. the Course screen
 *     still holding a stageNumber from the previous user)
 *   - Stale route state that ``CommonActions.reset`` would otherwise miss
 *
 * Two keys instead of one so the pre-login and post-login trees don't share
 * navigator identity.
 */
function RootNavigator() {
  const { token, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loading} testID="auth-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return token ? (
    <FeatureErrorBoundary name="App">
      <RootStack key="auth" />
    </FeatureErrorBoundary>
  ) : (
    <FeatureErrorBoundary name="Auth">
      <AuthNavigator key="anon" />
    </FeatureErrorBoundary>
  );
}

function ConfigErrorScreen({ message }: { message: string }): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.configError} testID="config-error">
          <Text style={styles.configErrorHeading}>Configuration error</Text>
          <Text style={styles.configErrorMessage}>{message}</Text>
          {/* BUG-FRONTEND-INFRA-018: the production deployment recipe lives in
              ``DEPLOYMENT.md``; the in-app copy stays provider-agnostic so it
              reads sensibly whether the backend is on Railway, Fly, or a
              local tunnel. */}
          <Text style={styles.configErrorHint}>
            Set EXPO_PUBLIC_API_BASE_URL at build time (see DEPLOYMENT.md for platform-specific
            instructions) so it is baked into the web bundle.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/**
 * BUG-FRONTEND-INFRA-021 — reflect the current color scheme so the status
 * bar glyphs remain legible in dark mode. Falls back to the system default.
 */
function ThemedStatusBar(): React.JSX.Element {
  const scheme = useColorScheme() ?? Appearance.getColorScheme() ?? 'light';
  return <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />;
}

export default function App(): React.JSX.Element {
  if (CONFIG_ERROR) {
    return <ConfigErrorScreen message={CONFIG_ERROR} />;
  }
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <NetworkStatusProvider>
          <AuthProvider>
            <ApiKeyProvider>
              <ToastProvider>
                <NavigationContainer linking={linking}>
                  <SafeAreaView style={styles.safeArea}>
                    <ThemedStatusBar />
                    <OfflineBanner />
                    <RootNavigator />
                  </SafeAreaView>
                </NavigationContainer>
              </ToastProvider>
            </ApiKeyProvider>
          </AuthProvider>
        </NetworkStatusProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background.card,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  configError: {
    padding: SPACING.xl,
    paddingTop: SPACING.xxl + SPACING.lg,
  },
  configErrorHeading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: SPACING.md,
  },
  configErrorMessage: {
    fontSize: 16,
    color: colors.text.primary,
    marginBottom: SPACING.lg,
  },
  configErrorHint: {
    fontSize: 14,
    color: colors.text.secondary,
  },
});
