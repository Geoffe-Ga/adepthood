/**
 * ``QuoteRow`` — the one look a promoted quote has wherever it is listed: a
 * warm apricot wash with a terracotta stripe down its left edge, the quoted
 * words set in the note face, and an optional caption beneath naming where
 * they came from.
 *
 * Shared by the reflection sources panel (fold a waiting quote into a review)
 * and the Promoted quotes screen (#2865), so a quote is recognisably the same
 * object in both places. The row owns only its look and its one press; any
 * secondary action (the screen's Remove) sits in ``trailing``, a SIBLING of
 * the pressable rather than nested inside it, so the two presses never fight
 * and each keeps its own accessible name.
 */
import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  touchTarget,
} from '@/design/tokens';

/** Warm left rule marking a promoted quote, in dp. */
export const QUOTE_STRIPE_WIDTH = 3;

/** Dim a quote that has already been used, so it reads as a quiet trace. */
const DIMMED_ROW_OPACITY = 0.5;

/** How many lines of the quote a row shows before it truncates, by default. */
const DEFAULT_QUOTE_LINES = 2;

export interface QuoteRowProps {
  /** The quoted words, verbatim. */
  text: string;
  /** A line beneath the quote naming its source (and, where used, its review). */
  caption?: string;
  /** Dim the row: the quote has already been folded into a review. */
  dimmed?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  testID: string;
  numberOfLines?: number;
  /** A secondary control rendered beside, never inside, the pressable row. */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** A promoted quote as a tappable, stripe-marked row. */
export function QuoteRow({
  text,
  caption,
  dimmed = false,
  onPress,
  accessibilityLabel,
  accessibilityState,
  testID,
  numberOfLines = DEFAULT_QUOTE_LINES,
  trailing,
  style,
}: QuoteRowProps): React.JSX.Element {
  const row = (
    <TouchableOpacity
      style={[styles.row, dimmed && styles.dimmed, trailing != null && styles.rowWithTrailing]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text style={styles.text} numberOfLines={numberOfLines}>
        {text}
      </Text>
      {caption ? (
        <Text style={styles.caption} numberOfLines={1} testID={`${testID}-caption`}>
          {caption}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
  if (trailing == null) return style == null ? row : <View style={style}>{row}</View>;
  return (
    <View style={[styles.withTrailing, style]}>
      {row}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.quoteHighlight,
    borderLeftWidth: QUOTE_STRIPE_WIDTH,
    borderLeftColor: accent.primary,
  },
  rowWithTrailing: {
    flex: 1,
  },
  dimmed: {
    opacity: DIMMED_ROW_OPACITY,
  },
  text: {
    ...editorialType.note,
    color: ink.primary,
  },
  caption: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  withTrailing: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
});

export default QuoteRow;
