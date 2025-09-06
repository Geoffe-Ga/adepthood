// frontend/features/Journal/JournalScreen.tsx

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Placeholder journal screen.
 * Users will log reflections here in future iterations.
 */
const JournalScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Journal Screen</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 18,
  },
});

export default JournalScreen;
