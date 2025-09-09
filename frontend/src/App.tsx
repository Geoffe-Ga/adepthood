// frontend/src/App.tsx

import { NavigationContainer } from '@react-navigation/native';
import React from 'react';
import { StatusBar, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import BottomTabs from './navigation/BottomTabs';

import { auth } from '@/api';

void auth;
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar barStyle="dark-content" />
          <BottomTabs />
        </SafeAreaView>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
