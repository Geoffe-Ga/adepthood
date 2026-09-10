/**
 * Read-mode rendering of an entry body with each anchored span softly
 * highlighted and tappable. The offset math lives in {@link buildAnchoredSegments};
 * this only maps segments to a composed ``<Text>`` tree. Margin-note anchors and
 * reader-promoted quote spans share the same body, resolved to one anchor stream.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { buildAnchoredSegments, type AnchoredSegment } from './highlightSegments';
import entryStyles from './JournalEntry.styles';
import {
  markdownRuns,
  parseJournalMarkdown,
  type JournalMarkdownDocument,
  type JournalMarkdownLine,
  type JournalMarkdownRun,
} from './journalMarkdown';

import type { Marginalia, PromotedQuote } from '@/api';
import { Button } from '@/components/Button';
import { SPACING, colors, editorialType } from '@/design/tokens';

/** No-op default so the remove card always has a callable press handler. */
const NOOP = (): void => {};

/** Cap the echoed quote text so a long passage doesn't blow out the card. */
const REMOVE_QUOTE_MAX_LINES = 3;
/** A visible quotation rule, shared in weight with the course reader's rule. */
const JOURNAL_QUOTE_RULE_WIDTH = 3;

// React Native's public ViewProps omit the click callback that both the native
// host view and React Native Web support. Keeping it on a View avoids Pressable's
// implicit button-like tab stop and pointer cursor around the journal reader.
type BodyViewProps = React.ComponentProps<typeof View> & { onClick?: () => void };
const BodyView = View as React.ComponentType<BodyViewProps>;

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
  quote,
  onPress,
  children,
  continuation,
}: {
  quote: PromotedQuote;
  onPress?: (_quote: PromotedQuote) => void;
  children: React.ReactNode;
  continuation: boolean;
}): React.JSX.Element {
  return (
    <Text
      style={quote.pending ? styles.quotePending : styles.quoteIncluded}
      onPress={
        onPress
          ? (event) => {
              event?.stopPropagation();
              onPress(quote);
            }
          : undefined
      }
      accessibilityRole="link"
      accessibilityLabel={quote.pending ? 'Promoted passage' : 'Included passage'}
      testID={
        continuation ? `quote-highlight-${quote.id}-continuation` : `quote-highlight-${quote.id}`
      }
    >
      {children}
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

/** Semantic roles become matching HTML elements on web; native uses the style. */
function webRole(role: 'strong' | 'emphasis' | 'blockquote'): never | undefined {
  return Platform.OS === 'web' ? (role as never) : undefined;
}

/** Render one visible inline run, composing bold + italic when both apply. */
function renderMarkdownRun(run: JournalMarkdownRun): React.ReactNode {
  let node: React.ReactNode = run.text;
  if (run.italic) {
    node = (
      <Text
        key={`italic-${run.start}`}
        role={webRole('emphasis')}
        style={styles.italic}
        testID={`journal-markdown-italic-${run.start}`}
      >
        {node}
      </Text>
    );
  }
  if (run.bold) {
    node = (
      <Text
        key={`bold-${run.start}`}
        role={webRole('strong')}
        style={styles.bold}
        testID={`journal-markdown-bold-${run.start}`}
      >
        {node}
      </Text>
    );
  }
  return node;
}

function segmentEnd(segment: AnchoredSegment): number {
  return segment.start + Array.from(segment.text).length;
}

/** Visible Markdown content, or the literal syntax that is itself anchored. */
function anchoredSliceContent(
  document: JournalMarkdownDocument,
  start: number,
  end: number,
  hasAnchor: boolean,
): React.ReactNode[] {
  const runs = markdownRuns(document, start, end);
  if (runs.length > 0) return runs.map(renderMarkdownRun);
  // A selection may consist solely of hidden Markdown punctuation. Showing that
  // tiny literal only while it owns an anchor keeps the saved note/promotion
  // discoverable and removable instead of creating an unreachable database row.
  return hasAnchor ? [document.chars.slice(start, end).join('')] : [];
}

/** Render one body segment: a note anchor, a promoted-quote span, or plain text. */
function renderAnchoredSlice(
  segment: AnchoredSegment,
  start: number,
  end: number,
  document: JournalMarkdownDocument,
  claimedAnchors: Set<string>,
  onOpen: (_note: Marginalia) => void,
  onQuotePress?: (_quote: PromotedQuote) => void,
): React.ReactNode {
  const { note, quote } = segment;
  const content = anchoredSliceContent(document, start, end, note != null || quote != null);
  if (content.length === 0) return null;
  if (note != null) {
    const claim = `note-${note.id}`;
    const continuation = claimedAnchors.has(claim);
    claimedAnchors.add(claim);
    return (
      <Text
        key={`${segment.start}-${start}`}
        style={[styles.highlight, { color: colors.marginalia[note.kind] }]}
        onPress={(event) => {
          event?.stopPropagation();
          onOpen(note);
        }}
        accessibilityRole="link"
        accessibilityLabel={`Highlighted ${note.kind} passage`}
        testID={continuation ? `highlight-${note.id}-continuation` : `highlight-${note.id}`}
      >
        {content}
      </Text>
    );
  }
  if (quote != null) {
    const claim = `quote-${quote.id}`;
    const continuation = claimedAnchors.has(claim);
    claimedAnchors.add(claim);
    return (
      <QuoteSpan
        key={`${segment.start}-${start}`}
        quote={quote}
        onPress={onQuotePress}
        continuation={continuation}
      >
        {content}
      </QuoteSpan>
    );
  }
  return content;
}

/** Intersect the anchor stream with one visible source line. */
function renderLine(
  line: JournalMarkdownLine,
  segments: AnchoredSegment[],
  document: JournalMarkdownDocument,
  claimedAnchors: Set<string>,
  onOpen: (_note: Marginalia) => void,
  onQuotePress?: (_quote: PromotedQuote) => void,
): React.ReactNode[] {
  const rendered: React.ReactNode[] = [];
  for (const segment of segments) {
    const start = Math.max(line.start, segment.start);
    const end = Math.min(line.end, segmentEnd(segment));
    if (start >= end) continue;
    rendered.push(
      renderAnchoredSlice(segment, start, end, document, claimedAnchors, onOpen, onQuotePress),
    );
  }
  return rendered;
}

/** Render every line in a block, restoring only the line feeds between them. */
function renderBlockLines(
  lines: JournalMarkdownLine[],
  segments: AnchoredSegment[],
  document: JournalMarkdownDocument,
  claimedAnchors: Set<string>,
  onOpen: (_note: Marginalia) => void,
  onQuotePress?: (_quote: PromotedQuote) => void,
): React.ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index === 0 ? [] : [`\n`]),
    ...renderLine(line, segments, document, claimedAnchors, onOpen, onQuotePress),
  ]);
}

/** Build the mixed prose/blockquote tree while assigning each anchor one primary ID. */
function renderDocumentBlocks(
  document: JournalMarkdownDocument,
  segments: AnchoredSegment[],
  onOpen: (_note: Marginalia) => void,
  onQuotePress?: (_quote: PromotedQuote) => void,
): React.ReactNode[] {
  const claimedAnchors = new Set<string>();
  return document.blocks.map((block) => {
    const content = renderBlockLines(
      block.lines,
      segments,
      document,
      claimedAnchors,
      onOpen,
      onQuotePress,
    );
    return block.quote ? (
      <View
        key={block.start}
        role={webRole('blockquote')}
        accessibilityLabel="Quote block"
        style={styles.quoteBlock}
        testID={`journal-markdown-quote-${block.start}`}
      >
        <Text style={styles.body}>{content}</Text>
      </View>
    ) : (
      <Text key={block.start} style={styles.body}>
        {content}
      </Text>
    );
  });
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
  const segments = React.useMemo(
    () => buildAnchoredSegments(body, notes, quotes),
    [body, notes, quotes],
  );
  const document = React.useMemo(() => parseJournalMarkdown(body), [body]);
  const removeText = findRemoveQuoteText(segments, removeTargetId);
  return (
    <>
      <BodyView
        accessible={false}
        style={styles.bodyContainer}
        testID="journal-body-read"
        onClick={removeTargetId != null ? onDismissRemove : undefined}
      >
        {renderDocumentBlocks(document, segments, onOpen, onQuotePress)}
      </BodyView>
      {removeTargetId != null && removeText != null ? (
        <RemoveQuoteCard id={removeTargetId} text={removeText} onConfirm={onConfirmRemove} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  bodyContainer: {
    alignItems: 'stretch',
  },
  body: {
    ...editorialType.body,
    color: colors.paper.ink,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  quoteBlock: {
    backgroundColor: colors.paper.backgroundAlt,
    borderLeftWidth: JOURNAL_QUOTE_RULE_WIDTH,
    borderLeftColor: colors.paper.inkSoft,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    marginVertical: SPACING.sm,
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
