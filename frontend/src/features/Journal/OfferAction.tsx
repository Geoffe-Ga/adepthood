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

/**
 * Dims an action held while a write is in flight, matching the 0.5 the
 * Practice controls use for the same state, so a held button reads as
 * waiting rather than broken. Disabled controls are exempt from the WCAG
 * text-contrast floor; the label stays legible on the card.
 */
export const OFFER_ACTION_DISABLED_OPACITY = 0.5;

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
      style={[
        styles.action,
        emphasis ? styles.actionEmphasis : null,
        disabled ? styles.actionDisabled : null,
      ]}
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
  actionDisabled: {
    opacity: OFFER_ACTION_DISABLED_OPACITY,
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
