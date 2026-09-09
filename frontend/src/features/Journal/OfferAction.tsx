/**
 * ``OfferAction`` — one button in the hand of a finished-session note.
 *
 * Extracted from ``WritingSessionOffer`` when a second branch (keeping the
 * session as a practice) grew beside the first: both offers make the same
 * shape of promise to the writer, and a second copy of this button is the
 * cheapest way for the two to drift into disagreeing about what a tap target
 * is. Everything it fixes is a rule the note is held to elsewhere — a touch
 * target no smaller than the design system's floor, a label at
 * ``editorialType.action`` so it reads as pressable, and an accessibility
 * label that says what the tap does rather than repeating the visible word.
 *
 * ``emphasis`` marks the action that commits, never the one that declines: a
 * decline drawn smaller than its sibling is a decline the writer has to hunt
 * for, and this note's whole claim is that saying no costs one tap.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, editorialType, touchTarget } from '@/design/tokens';

export interface OfferActionProps {
  /** The visible word. */
  label: string;
  /** What a screen reader says instead — the whole action, not just the word. */
  a11yLabel: string;
  onPress: () => void;
  testID: string;
  /** Outlines the action that commits. Never set on a decline. */
  emphasis?: boolean;
  /** Held while a write is in flight, so a second tap cannot spend it twice. */
  disabled?: boolean;
}

/** A pair of these is what every step of the note offers the writer. */
function OfferAction({
  label,
  a11yLabel,
  onPress,
  testID,
  emphasis = false,
  disabled = false,
}: OfferActionProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.action, emphasis ? styles.actionEmphasis : null]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled }}
      testID={testID}
    >
      <Text style={[styles.actionLabel, emphasis ? styles.actionLabelEmphasis : null]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  actionEmphasis: {
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.inkSoft,
  },
  actionLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  actionLabelEmphasis: {
    color: colors.paper.ink,
  },
});

export default OfferAction;
