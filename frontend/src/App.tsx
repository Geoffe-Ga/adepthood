// frontend/src/App.tsx

import type { LinkingOptions } from '@react-navigation/native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './context/AuthContext';
import LoginScreen from './features/Auth/LoginScreen';
import SignupScreen from './features/Auth/SignupScreen';
import type { RootTabParamList } from './navigation/BottomTabs';
import BottomTabs from './navigation/BottomTabs';

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

  return token ? <BottomTabs /> : <AuthNavigator />;
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer linking={linking}>
          <SafeAreaView style={styles.safeArea}>
            <StatusBar barStyle="dark-content" />
            <RootNavigator />
          </SafeAreaView>
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
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
});
