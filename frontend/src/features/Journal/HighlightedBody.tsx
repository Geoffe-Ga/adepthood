/**
 * Read-mode rendering of an entry body with each anchored span softly
 * highlighted and tappable. The offset math lives in {@link buildAnchoredSegments};
 * this only maps segments to a composed ``<Text>`` tree. Margin-note anchors and
 * reader-promoted quote spans share the same body, resolved to one anchor stream.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { buildAnchoredSegments, type AnchoredSegment } from './highlightSegments';

import type { Marginalia, PromotedQuote } from '@/api';
import { colors, editorialType } from '@/design/tokens';

export interface HighlightedBodyProps {
  body: string;
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
  /** Reader-promoted quote spans; defaults to none. */
  quotes?: PromotedQuote[];
  /** Tapping a promoted-quote span hands back its quote. */
  onQuotePress?: (_quote: PromotedQuote) => void;
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

function HighlightedBody({
  body,
  notes,
  onOpen,
  quotes = [],
  onQuotePress,
}: HighlightedBodyProps): React.JSX.Element {
  const segments = buildAnchoredSegments(body, notes, quotes);
  return (
    <Text style={styles.body} testID="journal-body-read">
      {segments.map((segment) => {
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
          return (
            <QuoteSpan key={segment.start} segment={segment} quote={quote} onPress={onQuotePress} />
          );
        }
        return segment.text;
      })}
    </Text>
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
