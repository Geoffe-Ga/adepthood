import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export interface RadioOptionProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  accessibilityHint?: string;
  style: StyleProp<ViewStyle>;
  selectedStyle: StyleProp<ViewStyle>;
  labelStyle: StyleProp<TextStyle>;
  selectedLabelStyle: StyleProp<TextStyle>;
}

export interface RadioGroupProps {
  style: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  children: React.ReactNode;
}

/**
 * A single radio-like option. The label doubles as the visible text and the
 * screen-reader accessibilityLabel, and the selected state drives both the
 * container and label style overlays as well as the announced selection.
 */
export function RadioOption({
  label,
  selected,
  onPress,
  testID,
  accessibilityHint,
  style,
  selectedStyle,
  labelStyle,
  selectedLabelStyle,
}: RadioOptionProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[style, selected && selectedStyle]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      testID={testID}
    >
      <Text style={[labelStyle, selected && selectedLabelStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * The container for a set of {@link RadioOption} children. Exposes the
 * radiogroup role so assistive tech treats the options as one exclusive choice.
 */
export function RadioGroup({
  style,
  accessibilityLabel,
  children,
}: RadioGroupProps): React.JSX.Element {
  return (
    <View style={style} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {children}
    </View>
  );
}
