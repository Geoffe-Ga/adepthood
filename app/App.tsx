// app/App.tsx

import React from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import HabitsScreen from './features/Habits/HabitsScreen';

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <HabitsScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
