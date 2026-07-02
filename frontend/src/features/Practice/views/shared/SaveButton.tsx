import React from 'react';
import type { AccessibilityState, ViewStyle } from 'react-native';
import { Pressable, Text } from 'react-native';

import {
  SESSION_BUTTON_BASE,
  SESSION_BUTTON_DISABLED,
  SESSION_BUTTON_TEXT,
  SUCCESS_FILL,
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

/** Filled success session CTA (Save session) on a flat style array. */
export const SaveButton = ({
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
    style={[SESSION_BUTTON_BASE, SUCCESS_FILL, style, disabled && SESSION_BUTTON_DISABLED]}
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
