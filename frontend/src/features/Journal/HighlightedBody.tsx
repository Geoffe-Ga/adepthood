/**
 * Read-mode rendering of an entry body with each anchored span softly
 * highlighted and tappable. The offset math lives in {@link buildAnchoredSegments};
 * this only maps segments to a composed ``<Text>`` tree. Margin-note anchors and
 * reader-promoted quote spans share the same body, resolved to one anchor stream.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { buildAnchoredSegments, type AnchoredSegment } from './highlightSegments';
import entryStyles from './JournalEntry.styles';

import type { Marginalia, PromotedQuote } from '@/api';
import { Button } from '@/components/Button';
import { colors, editorialType } from '@/design/tokens';

/** No-op default so the remove card always has a callable press handler. */
const NOOP = (): void => {};

/** Cap the echoed quote text so a long passage doesn't blow out the card. */
const REMOVE_QUOTE_MAX_LINES = 3;

export interface HighlightedBodyProps {
  body: string;
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
  /** Reader-promoted quote spans; defaults to none. */
  quotes?: PromotedQuote[];
  /** Tapping a promoted-quote span hands back its quote. */
  onQuotePress?: (_quote: PromotedQuote) => void;
  /** The promoted quote whose anchored remove card is revealed, if any. */
  removeTargetId?: number | null;
  /** Confirm removing the revealed quote. */
  onConfirmRemove?: () => void;
  /** Dismiss the revealed remove card (tapping elsewhere in the body). */
  onDismissRemove?: () => void;
}

/** A promoted-quote span: washed while pending, quietly dimmed once folded in. */
function QuoteSpan({
  segment,
  quote,
  onPress,
}: {
  segment: AnchoredSegment;
  quote: PromotedQuote;
  onPress?: (_quote: PromotedQuote) => void;
}): React.JSX.Element {
  return (
    <Text
      style={quote.pending ? styles.quotePending : styles.quoteIncluded}
      onPress={onPress ? () => onPress(quote) : undefined}
      accessibilityRole="link"
      accessibilityLabel={quote.pending ? 'Promoted passage' : 'Included passage'}
      testID={`quote-highlight-${quote.id}`}
    >
      {segment.text}
    </Text>
  );
}

/**
 * The anchor text of the promoted quote whose remove card is revealed, or null.
 * Located through the built segment stream (so an out-of-range quote — one with
 * no drawn span, hence untappable — never yields a card), and read from the
 * quote's own ``anchor_text`` rather than a re-slice of the body.
 */
function findRemoveQuoteText(
  segments: AnchoredSegment[],
  removeTargetId: number | null,
): string | null {
  if (removeTargetId == null) return null;
  const match = segments.find((s) => s.quote != null && s.quote.id === removeTargetId);
  return match != null && match.quote != null ? match.quote.anchor_text : null;
}

/** Anchored card echoing a tapped quote's text with a Remove-promotion action. */
function RemoveQuoteCard({
  id,
  text,
  onConfirm,
}: {
  id: number;
  text: string;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <View style={entryStyles.promotionRemoveCard}>
      <Text
        style={entryStyles.promotionRemoveQuote}
        numberOfLines={REMOVE_QUOTE_MAX_LINES}
        testID={`promotion-remove-quote-${id}`}
      >
        {text}
      </Text>
      <Button
        variant="secondary"
        label="Remove promotion"
        accessibilityLabel="Remove promotion"
        testID={`promotion-remove-${id}`}
        onPress={onConfirm}
      />
    </View>
  );
}

/** Render one body segment: a note anchor, a promoted-quote span, or plain text. */
function renderSegment(
  segment: AnchoredSegment,
  onOpen: (_note: Marginalia) => void,
  onQuotePress?: (_quote: PromotedQuote) => void,
): React.ReactNode {
  const { note, quote } = segment;
  if (note != null) {
    return (
      <Text
        key={segment.start}
        style={[styles.highlight, { color: colors.marginalia[note.kind] }]}
        onPress={() => onOpen(note)}
        accessibilityRole="link"
        accessibilityLabel={`Highlighted ${note.kind} passage`}
        testID={`highlight-${note.id}`}
      >
        {segment.text}
      </Text>
    );
  }
  if (quote != null) {
    return <QuoteSpan key={segment.start} segment={segment} quote={quote} onPress={onQuotePress} />;
  }
  return segment.text;
}

function HighlightedBody({
  body,
  notes,
  onOpen,
  quotes = [],
  onQuotePress,
  removeTargetId = null,
  onConfirmRemove = NOOP,
  onDismissRemove,
}: HighlightedBodyProps): React.JSX.Element {
  const segments = buildAnchoredSegments(body, notes, quotes);
  const removeText = findRemoveQuoteText(segments, removeTargetId);
  return (
    <>
      <Text
        style={styles.body}
        testID="journal-body-read"
        // A tap on plain body text dismisses a revealed card; inner span onPress
        // handlers still win in nested RN Text, so quote taps keep revealing.
        onPress={removeTargetId != null ? onDismissRemove : undefined}
      >
        {segments.map((segment) => renderSegment(segment, onOpen, onQuotePress))}
      </Text>
      {removeTargetId != null && removeText != null ? (
        <RemoveQuoteCard id={removeTargetId} text={removeText} onConfirm={onConfirmRemove} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  body: {
    ...editorialType.body,
    color: colors.paper.ink,
  },
  highlight: {
    // Soft paper-toned wash; the kind colour comes from the inline text colour so
    // there are no colour literals here.
    backgroundColor: colors.paper.anchorHighlight,
    fontWeight: '600',
  },
  quotePending: {
    // A warm apricot wash marks a live promoted span, distinct from the golden
    // note anchor; the ink keeps full contrast (AA) over the wash.
    backgroundColor: colors.paper.quoteHighlight,
    color: colors.paper.ink,
    fontWeight: '600',
  },
  quoteIncluded: {
    // Once folded into another entry the span reads quietly — dimmed ink, no wash.
    color: colors.paper.inkSoft,
  },
});

export default HighlightedBody;
