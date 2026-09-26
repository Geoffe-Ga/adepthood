/**
 * ``StaleQuoteNotes`` -- the promoted quotes whose passage has changed since
 * they were promoted, listed under the prose instead of drawn inside it.
 *
 * After an edit the server re-anchors each pending quote by its snapshot text
 * (``reanchor_one``); when that text is gone it marks the quote ``stale`` and
 * leaves its offsets where they were. Those offsets now address whatever the
 * writer typed there, so washing them inline would attach the quote to words it
 * never quoted. This footer keeps such a quote visible and honest -- its own
 * snapshot text, dimmed like a stale margin note, labelled stale for a screen
 * reader -- and still removable: a press hands it back through the same
 * ``onQuotePress`` the inline span uses, which opens the remove card.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { STALE_OPACITY } from './staleTreatment';

import type { PromotedQuote } from '@/api';
import { BORDER_RADIUS, SPACING, colors, editorialType, touchTarget } from '@/design/tokens';

/** Cap the echoed snapshot so a long passage does not blow out the row. */
const STALE_QUOTE_MAX_LINES = 3;
/** A quiet left rule, the same weight as a margin slip's stripe. */
const STALE_QUOTE_RULE_WIDTH = 3;

export const STALE_QUOTE_CAPTION = 'The passage this quoted has changed.';

export interface StaleQuoteNotesProps {
  quotes: PromotedQuote[];
  onQuotePress?: (_quote: PromotedQuote) => void;
}

function StaleQuoteRow({
  quote,
  onPress,
}: {
  quote: PromotedQuote;
  onPress?: (_quote: PromotedQuote) => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress ? () => onPress(quote) : undefined}
      disabled={onPress == null}
      accessibilityRole="button"
      accessibilityLabel={`Stale promoted passage: ${quote.anchor_text}`}
      accessibilityHint="The entry no longer contains this passage. Opens an option to remove it."
      testID={`stale-quote-${quote.id}`}
    >
      <Text style={styles.excerpt} numberOfLines={STALE_QUOTE_MAX_LINES}>
        {quote.anchor_text}
      </Text>
      <Text style={styles.staleCaption}>{STALE_QUOTE_CAPTION}</Text>
    </TouchableOpacity>
  );
}

function StaleQuoteNotes({ quotes, onQuotePress }: StaleQuoteNotesProps): React.JSX.Element | null {
  if (quotes.length === 0) return null;
  return (
    <View style={styles.list} testID="stale-quotes">
      {quotes.map((quote) => (
        <StaleQuoteRow key={quote.id} quote={quote} onPress={onQuotePress} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
  row: {
    minHeight: touchTarget.minimum,
    opacity: STALE_OPACITY,
    backgroundColor: colors.paper.backgroundAlt,
    borderLeftWidth: STALE_QUOTE_RULE_WIDTH,
    borderLeftColor: colors.paper.inkSoft,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  excerpt: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  staleCaption: {
    ...editorialType.caption,
    fontStyle: 'italic',
    color: colors.paper.inkSoft,
    paddingTop: SPACING.xs,
  },
});

export default StaleQuoteNotes;
