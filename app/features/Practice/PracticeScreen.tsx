// app/features/Practice/PracticeScreen.tsx

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Placeholder practice screen.
 * The real implementation will host guided exercises for each stage.
 */
const PracticeScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Practice Screen</Text>
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

export default PracticeScreen;
