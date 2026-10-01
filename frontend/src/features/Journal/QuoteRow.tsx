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
 *
 * Given ``checked``, the row is a CHECKBOX instead (#2885's multi-select): the
 * role, ``accessibilityState.checked`` and -- on the web, where
 * react-native-web drops accessibilityState -- ``aria-checked``. The folded
 * trace (``marked``) is a different fact from being checked, and the two are
 * never carried by the same state.
 */
import { Check } from 'lucide-react-native';
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

import { decorativeHidden } from '@/components/a11yHidden';
import { webCheckedState, webDisabledState } from '@/components/webAria';
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

/** The folded-in check glyph's size in dp, sized to the note face it sits beside. */
const CHECK_GLYPH_SIZE = 20;

/** The selection box's side, in dp: the check glyph's size, so a row keeps its line height. */
const BOX_SIZE = CHECK_GLYPH_SIZE;

/** The tick drawn inside a checked box, inset from its edge. */
const BOX_GLYPH_SIZE = 14;

/** The selection box's outline, in dp. */
const BOX_BORDER_WIDTH = 2;

export interface QuoteRowProps {
  /** The quoted words, verbatim. */
  text: string;
  /** A line beneath the quote naming its source (and, where used, its review). */
  caption?: string;
  /** Dim the row: the quote has already been folded into a review. */
  dimmed?: boolean;
  /**
   * Draw a check glyph beside the words: the quote has been folded in (#2952).
   * Decorative by contract — the caller's ``accessibilityState`` carries the
   * meaning — so the glyph is hidden from assistive technology.
   */
  marked?: boolean;
  /**
   * Present only in a selection mode: the row becomes a checkbox with this
   * state, and draws a box beside the words. Absent, it stays a button.
   */
  checked?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  testID: string;
  numberOfLines?: number;
  /** A secondary control rendered beside, never inside, the pressable row. */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** The check glyph a folded-in quote wears; decorative, so hidden from assistive technology. */
function FoldedMark({ testID }: { testID: string }): React.JSX.Element {
  return (
    <View {...decorativeHidden()} testID={testID}>
      <Check size={CHECK_GLYPH_SIZE} color={accent.primary} />
    </View>
  );
}

/** The selection box a checkbox row draws; decorative, since the role carries it. */
function SelectBox({ checked, testID }: { checked: boolean; testID: string }): React.JSX.Element {
  return (
    <View
      style={[styles.box, checked && styles.boxChecked]}
      {...decorativeHidden()}
      testID={testID}
    >
      {checked ? <Check size={BOX_GLYPH_SIZE} color={accent.onPrimary} /> : null}
    </View>
  );
}

/** The role and state props a row carries: a button's, or a checkbox's when ``checked`` is set. */
function roleProps(checked: boolean | undefined, accessibilityState?: AccessibilityState) {
  if (checked === undefined) {
    // A folded row is disabled; say so on the web too, where the state is dropped.
    const disabled = accessibilityState?.disabled;
    return {
      accessibilityRole: 'button' as const,
      accessibilityState,
      ...(disabled === undefined ? {} : webDisabledState(disabled)),
    };
  }
  const disabled = accessibilityState?.disabled ?? false;
  return {
    accessibilityRole: 'checkbox' as const,
    accessibilityState: { ...accessibilityState, checked },
    ...webCheckedState(checked, disabled),
  };
}

/** The quote's words on one line with, when present, its selection box and folded glyph. */
function QuoteLine({
  text,
  checked,
  marked,
  numberOfLines,
  testID,
}: {
  text: string;
  checked: boolean | undefined;
  marked: boolean;
  numberOfLines: number;
  testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.line}>
      {checked === undefined ? null : <SelectBox checked={checked} testID={`${testID}-box`} />}
      <Text style={[styles.text, styles.textInLine]} numberOfLines={numberOfLines}>
        {text}
      </Text>
      {marked ? <FoldedMark testID={`${testID}-check`} /> : null}
    </View>
  );
}

/** A promoted quote as a tappable, stripe-marked row. */
export function QuoteRow({
  text,
  caption,
  dimmed = false,
  marked = false,
  checked,
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
      {...roleProps(checked, accessibilityState)}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <QuoteLine
        text={text}
        checked={checked}
        marked={marked}
        numberOfLines={numberOfLines}
        testID={testID}
      />
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
  /** The words and, once folded in, the check glyph on one line. */
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  box: {
    width: BOX_SIZE,
    height: BOX_SIZE,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: BOX_BORDER_WIDTH,
    borderColor: accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: {
    backgroundColor: accent.primary,
  },
  text: {
    ...editorialType.note,
    color: ink.primary,
  },
  /** Let the words wrap and truncate beside the glyph instead of pushing it out. */
  textInLine: {
    flexShrink: 1,
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
