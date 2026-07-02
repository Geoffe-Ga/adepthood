import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { accent, BORDER_RADIUS, SPACING, surface, touchTarget, uiType } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared button primitive in the warm "Candle & Ink" language (#801).
 * primary = terracotta fill (white label, 5.2:1 AA); secondary = warm outline;
 * tertiary = text-only accent. 44dp min height; press feedback is suppressed
 * under prefers-reduced-motion.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const isDisabled = disabled || busy;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy }}
      activeOpacity={reducedMotion ? 1 : 0.7}
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      style={[styles.base, styles[variant], isDisabled && styles.disabled, style]}
    >
      <Text style={[styles.label, labelStyles[variant]]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget.minimum,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.buttonV,
    paddingHorizontal: SPACING.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: accent.primary },
  secondary: { backgroundColor: surface.raised, borderWidth: 1, borderColor: accent.primary },
  tertiary: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.5 },
  label: { fontSize: uiType.button.fontSize, fontWeight: uiType.button.fontWeight },
});

const labelStyles = StyleSheet.create({
  primary: { color: accent.onPrimary }, // white on terracotta — 5.2:1 AA
  secondary: { color: accent.primary },
  tertiary: { color: accent.primary },
});
