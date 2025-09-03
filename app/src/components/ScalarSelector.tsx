import Slider from '@react-native-community/slider';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export type ScalarSelectorProps = {
  value: number;
  // eslint-disable-next-line no-unused-vars
  onChange: (value: number) => void;
  testID?: string;
};

const ScalarSelector = ({ value, onChange, testID }: ScalarSelectorProps) => (
  <View style={styles.container}>
    <Slider
      style={styles.slider}
      minimumValue={0}
      maximumValue={10}
      step={1}
      value={value}
      onValueChange={onChange}
      testID={testID}
    />
    <Text style={styles.valueLabel}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  slider: {
    flex: 1,
  },
  valueLabel: {
    width: 24,
    textAlign: 'center',
    fontWeight: '600',
  },
});

export default ScalarSelector;
