/** Shared dismiss/reopen affordance for the raised reflection cards — shared chrome, per-variant color/margin. */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { SPACING, accent, editorialType, ink, touchTarget } from '@/design/tokens';

/**
 * The two press-target treatments that share this affordance's chrome. ``dismiss``
 * is the muted collapse control that sits below a card's body; ``reopen`` is the
 * accent-toned restore control that sits flush (no top margin) where the collapsed
 * card left off.
 */
export type ReflectionDismissVariant = 'dismiss' | 'reopen';

export interface ReflectionDismissProps {
  label: string;
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
  /** Chrome treatment; defaults to the muted ``dismiss`` control. */
  variant?: ReflectionDismissVariant;
}

function ReflectionDismiss({
  label,
  accessibilityLabel,
  testID,
  onPress,
  variant = 'dismiss',
}: ReflectionDismissProps): React.JSX.Element {
  const isReopen = variant === 'reopen';
  return (
    <TouchableOpacity
      style={[styles.control, isReopen && styles.reopenControl]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text style={[styles.text, isReopen ? styles.reopenText : styles.dismissText]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  control: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reopenControl: {
    marginTop: 0,
  },
  text: {
    ...editorialType.note,
    fontWeight: '600',
  },
  dismissText: {
    color: ink.soft,
  },
  reopenText: {
    color: accent.primary,
  },
});

export default ReflectionDismiss;
