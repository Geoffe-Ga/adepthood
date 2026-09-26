/**
 * Shared radio primitive for exclusive-choice controls.
 *
 * Adoption criteria — a hand-rolled radio is a clean adopter only when every
 * point below holds. When one does not, keep the control local rather than
 * bending the primitive or weakening its a11y contract:
 * - each option is a single TouchableOpacity wrapping one Text label plus an
 *   optional hint line beneath it (no icons, badges, or other child nodes);
 * - the visible label doubles as the accessible name (they cannot differ); the
 *   hint is descriptive only and never contributes to that name;
 * - selection is announced through accessibilityState `selected`, not `checked`;
 * - the selected and unselected looks are expressed purely through the four
 *   style props, with no runtime-injected theme colors.
 */
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type {
  StyleProp,
  TextStyle,
  TouchableOpacityProps,
  ViewProps,
  ViewStyle,
} from 'react-native';

import { webDescribedBy, webRadioState } from './webAria';

export interface RadioOptionProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  accessibilityHint?: string;
  /** When true, the option is announced as disabled and cannot be pressed. */
  disabled?: boolean;
  /** Id of visible text that describes the option; linked on the web. */
  describedBy?: string;
  /**
   * A descriptive line rendered inside the option beneath the label, sharing
   * its left edge. It is not part of the accessible name: pair it with
   * `accessibilityHint` (native) and `describedBy` + `hintNativeID` (web).
   */
  hint?: string;
  /** The `nativeID` the hint text carries, so `describedBy` can point at it. */
  hintNativeID?: string;
  hintStyle?: StyleProp<TextStyle>;
  style: StyleProp<ViewStyle>;
  selectedStyle: StyleProp<ViewStyle>;
  labelStyle: StyleProp<TextStyle>;
  selectedLabelStyle: StyleProp<TextStyle>;
}

export interface RadioGroupProps {
  style: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** Id of text describing the whole choice (e.g. its error); linked on the web. */
  describedBy?: string;
  children: React.ReactNode;
}

/**
 * A single radio-like option. The label doubles as the visible text and the
 * screen-reader accessibilityLabel, and the selected state drives both the
 * container and label style overlays as well as the announced selection. An
 * optional hint sits inside the option under the label; it describes the
 * option but never names it.
 */
export function RadioOption({
  label,
  selected,
  onPress,
  testID,
  accessibilityHint,
  disabled = false,
  describedBy,
  hint,
  hintNativeID,
  hintStyle,
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
      disabled={disabled}
      testID={testID}
      // react-native-web ignores accessibilityState, so the web tree gets the
      // same facts as aria-* props, plus the text that describes the option.
      {...webRadioState<TouchableOpacityProps>(selected, disabled)}
      {...webDescribedBy<TouchableOpacityProps>(describedBy)}
    >
      <Text style={[labelStyle, selected && selectedLabelStyle]}>{label}</Text>
      {hint === undefined ? null : (
        <Text
          allowFontScaling
          nativeID={hintNativeID}
          importantForAccessibility="no"
          style={hintStyle}
        >
          {hint}
        </Text>
      )}
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
  describedBy,
  children,
}: RadioGroupProps): React.JSX.Element {
  return (
    <View
      style={style}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      {...webDescribedBy<ViewProps>(describedBy)}
    >
      {children}
    </View>
  );
}
