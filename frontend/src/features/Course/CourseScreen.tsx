// frontend/features/Course/CourseScreen.tsx

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Placeholder course screen.
 * The full version will present the APTITUDE curriculum content.
 */
const CourseScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Course Screen</Text>
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

export default CourseScreen;
