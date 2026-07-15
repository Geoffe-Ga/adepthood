/**
 * Shared radio primitive for exclusive-choice controls.
 *
 * Adoption criteria — a hand-rolled radio is a clean adopter only when every
 * point below holds. When one does not, keep the control local rather than
 * bending the primitive or weakening its a11y contract:
 * - each option is a single TouchableOpacity wrapping exactly one Text label
 *   (no icons, badges, description lines, or other child nodes);
 * - the visible label doubles as the accessible name (they cannot differ);
 * - selection is announced through accessibilityState `selected`, not `checked`;
 * - the selected and unselected looks are expressed purely through the four
 *   style props, with no runtime-injected theme colors.
 */
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export interface RadioOptionProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  accessibilityHint?: string;
  /** When true, the option is announced as disabled to assistive tech. */
  disabled?: boolean;
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
  disabled = false,
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
      accessibilityState={{ selected, disabled }}
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
