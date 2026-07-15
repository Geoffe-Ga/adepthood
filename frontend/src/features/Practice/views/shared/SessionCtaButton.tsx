import React from 'react';
import type { AccessibilityState, ViewStyle } from 'react-native';
import { Pressable, Text } from 'react-native';

import {
  PRIMARY_FILL,
  SESSION_BUTTON_BASE,
  SESSION_BUTTON_DISABLED,
  SESSION_BUTTON_TEXT,
  SUCCESS_FILL,
} from './sessionStyles';

/** Fill styling for the two session CTA roles. */
type SessionCtaVariant = 'primary' | 'success';

const VARIANT_FILL: Readonly<Record<SessionCtaVariant, ViewStyle>> = {
  primary: PRIMARY_FILL,
  success: SUCCESS_FILL,
};

interface Props {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  testID: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  style?: ViewStyle;
  /** `primary` (brand fill, default) advances; `success` saves the session. */
  variant?: SessionCtaVariant;
}

/** Filled session CTA on a flat style array; `variant` picks the fill token. */
export const SessionCtaButton = ({
  label,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  style,
  variant = 'primary',
}: Props): React.JSX.Element => (
  <Pressable
    style={[SESSION_BUTTON_BASE, VARIANT_FILL[variant], style, disabled && SESSION_BUTTON_DISABLED]}
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
