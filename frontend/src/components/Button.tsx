import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

import { accent, BORDER_RADIUS, SPACING, surface, touchTarget, uiType } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary';

/** ``testID`` of the in-progress mark a busy ``Button`` draws. */
export const busyIndicatorTestID = (testID?: string): string => `${testID ?? 'button'}-busy`;

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * Optional leading node, drawn before the label inside the same row. It exists
   * for a button whose mark is mandated from outside the design system — the
   * Sign in with Google button — and is decorative by contract: the button's own
   * ``accessibilityLabel`` stays the accessible name, so the caller is
   * responsible for hiding the node from assistive technology.
   */
  icon?: React.ReactNode;
  /** Optional override for the label, layered over the variant's own colour. */
  labelStyle?: StyleProp<TextStyle>;
}

/**
 * The in-progress mark a busy button draws, in the house pattern already set by
 * ``GetResonanceButton``: a small indicator *beside* the label rather than in
 * place of it, so a reader still knows what is working. It carries no accessible
 * name of its own — the button announces ``busy`` itself, and a second voice for
 * the same fact is noise. Under reduced motion it settles into a static mark
 * (``hidesWhenStopped`` off, or stopping would hide it) rather than spinning.
 *
 * The colour is the label's own resolved colour, so it reads on the terracotta
 * fill, the warm outline and the text-only tertiary alike — and follows a
 * ``labelStyle`` override onto a foreign fill the design system does not own.
 */
function BusyIndicator({
  color,
  reducedMotion,
  testID,
}: {
  color: TextStyle['color'];
  reducedMotion: boolean;
  testID: string;
}): React.JSX.Element {
  return (
    <ActivityIndicator
      accessible={false}
      animating={!reducedMotion}
      color={color}
      hidesWhenStopped={false}
      size="small"
      style={styles.busyIndicator}
      testID={testID}
    />
  );
}

/**
 * Shared button primitive in the warm "Candle & Ink" language (#801).
 * primary = terracotta fill (white label, 5.2:1 AA); secondary = warm outline;
 * tertiary = text-only accent. 44dp min height; press feedback is suppressed
 * under prefers-reduced-motion.
 *
 * ``busy`` and ``disabled`` both stop the press and both dim the button, but
 * only ``busy`` draws the in-progress mark: a control disabled because the form
 * is invalid must not claim to be working (#2441).
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
  icon,
  labelStyle,
}: ButtonProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const isDisabled = disabled || busy;
  // Resolved rather than assumed: the mark takes whatever colour the label
  // actually lands on, including a caller's ``labelStyle`` override.
  const labelColor = StyleSheet.flatten<TextStyle>([labelStyles[variant], labelStyle]).color;
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
      {busy ? (
        <BusyIndicator
          color={labelColor}
          reducedMotion={reducedMotion}
          testID={busyIndicatorTestID(testID)}
        />
      ) : null}
      {icon}
      <Text style={[styles.label, labelStyles[variant], labelStyle]}>{label}</Text>
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
  // The gap lives on the mark, not on the row: the row has no ``gap`` of its own
  // because one caller (the Google button) mandates an exact icon-to-label
  // distance, and a row gap would widen it.
  busyIndicator: { marginRight: SPACING.sm },
  label: { fontSize: uiType.button.fontSize, fontWeight: uiType.button.fontWeight },
});

const labelStyles = StyleSheet.create({
  primary: { color: accent.onPrimary }, // white on terracotta — 5.2:1 AA
  secondary: { color: accent.primary },
  tertiary: { color: accent.primary },
});
