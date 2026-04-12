// frontend/src/App.tsx

import type { LinkingOptions } from '@react-navigation/native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { CONFIG_ERROR } from './config';
import { ApiKeyProvider } from './context/ApiKeyContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginScreen from './features/Auth/LoginScreen';
import SignupScreen from './features/Auth/SignupScreen';
import type { RootTabParamList } from './navigation/BottomTabs';
import RootStack from './navigation/RootStack';

type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

/** Deep linking configuration for the bottom tab navigator. */
const linking: LinkingOptions<RootTabParamList> = {
  prefixes: ['adepthood://'],
  config: {
    screens: {
      Habits: 'habits',
      Practice: 'practice/:stageNumber?',
      Course: 'course/:stageNumber?',
      Journal: 'journal',
      Map: 'map',
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

function RootNavigator() {
  const { token, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loading} testID="auth-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return token ? <RootStack /> : <AuthNavigator />;
}

function ConfigErrorScreen({ message }: { message: string }): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.configError} testID="config-error">
          <Text style={styles.configErrorHeading}>Configuration error</Text>
          <Text style={styles.configErrorMessage}>{message}</Text>
          <Text style={styles.configErrorHint}>
            Set EXPO_PUBLIC_API_BASE_URL as a Railway service variable (and ensure it is passed
            through as a Docker build arg) so it is baked into the web bundle at build time.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default function App(): React.JSX.Element {
  if (CONFIG_ERROR) {
    return <ConfigErrorScreen message={CONFIG_ERROR} />;
  }
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <ApiKeyProvider>
            <ToastProvider>
              <NavigationContainer linking={linking}>
                <SafeAreaView style={styles.safeArea}>
                  <StatusBar barStyle="dark-content" />
                  <RootNavigator />
                </SafeAreaView>
              </NavigationContainer>
            </ToastProvider>
          </ApiKeyProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  configError: {
    padding: 24,
    paddingTop: 48,
  },
  configErrorHeading: {
    fontSize: 20,
    fontWeight: '700',
    color: '#b00020',
    marginBottom: 12,
  },
  configErrorMessage: {
    fontSize: 16,
    color: '#222',
    marginBottom: 16,
  },
  configErrorHint: {
    fontSize: 14,
    color: '#555',
  },
});
