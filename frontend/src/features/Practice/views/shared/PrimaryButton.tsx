import React from 'react';
import type { AccessibilityState, ViewStyle } from 'react-native';
import { Pressable, Text } from 'react-native';

import {
  PRIMARY_FILL,
  SESSION_BUTTON_BASE,
  SESSION_BUTTON_DISABLED,
  SESSION_BUTTON_TEXT,
} from './sessionStyles';

interface Props {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  testID: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  style?: ViewStyle;
}

/** Filled brand-primary session CTA (Begin / advance) on a flat style array. */
export const PrimaryButton = ({
  label,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  style,
}: Props): React.JSX.Element => (
  <Pressable
    style={[SESSION_BUTTON_BASE, PRIMARY_FILL, style, disabled && SESSION_BUTTON_DISABLED]}
    onPress={disabled ? undefined : onPress}
    disabled={disabled}
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityHint={accessibilityHint}
    accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
  >
    <Text style={SESSION_BUTTON_TEXT}>{label}</Text>
  </Pressable>
);
