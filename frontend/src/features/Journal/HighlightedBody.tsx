/**
 * Read-mode rendering of an entry body with each anchored span softly
 * highlighted and tappable. The offset math lives in {@link buildAnchoredSegments};
 * this only maps segments to a composed ``<Text>`` tree. Margin-note anchors and
 * reader-promoted quote spans share the same body, resolved to one anchor stream.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useFocusScroll, type FocusScrollValue } from './focusSpanScroll';
import {
  buildAnchoredSegments,
  partitionQuotes,
  resolveFocusSpan,
  type AnchoredSegment,
  type ResolvedFocusSpan,
} from './highlightSegments';
import entryStyles from './JournalEntry.styles';
import {
  markdownRuns,
  parseJournalMarkdown,
  type JournalMarkdownBlock,
  type JournalMarkdownDocument,
  type JournalMarkdownLine,
} from './journalMarkdown';
import { bulletDecoration, renderMarkdownRun, webRole } from './ReadOnlyMarkdownText';
import { lineSlice } from './renderedSpans';
import StaleQuoteNotes from './StaleQuoteNotes';

import type { Marginalia, PromotedQuote } from '@/api';
import { Button } from '@/components/Button';
import { SPACING, accent, colors, editorialType } from '@/design/tokens';

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
  focused,
}: {
  quote: PromotedQuote;
  onPress?: (_quote: PromotedQuote) => void;
  children: React.ReactNode;
  continuation: boolean;
  /** The quote the reader arrived to see: it carries an underline as well. */
  focused: boolean;
}): React.JSX.Element {
  return (
    <Text
      style={[
        quote.pending ? styles.quotePending : styles.quoteIncluded,
        focused && styles.focused,
      ]}
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
      testID={quoteTestID(quote.id, continuation, focused)}
    >
      {children}
    </Text>
  );
}

/** A quote span's testID: its primary run, a continuation, or the focused primary run. */
function quoteTestID(id: number, continuation: boolean, focused: boolean): string {
  if (continuation) return `quote-highlight-${id}-continuation`;
  return focused ? `quote-highlight-${id}-focused` : `quote-highlight-${id}`;
}

/**
 * The anchor text of the promoted quote whose remove card is revealed, or null.
 * Located through the built segment stream (so an out-of-range quote — one with
 * no drawn span, hence untappable — never yields a card) or among the detached
 * quotes listed under the prose (each tappable there), and read from the
 * quote's own ``anchor_text`` rather than a re-slice of the body.
 */
function findRemoveQuoteText(
  segments: AnchoredSegment[],
  detachedQuotes: PromotedQuote[],
  removeTargetId: number | null,
): string | null {
  if (removeTargetId == null) return null;
  const match = segments.find((s) => s.quote != null && s.quote.id === removeTargetId);
  if (match != null && match.quote != null) return match.quote.anchor_text;
  const detached = detachedQuotes.find((q) => q.id === removeTargetId);
  return detached != null ? detached.anchor_text : null;
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

/** Everything the block renderers share for one pass over the body. */
interface RenderContext {
  document: JournalMarkdownDocument;
  /** Anchors already given their primary testID in this pass. */
  claimedAnchors: Set<string>;
  onOpen: (_note: Marginalia) => void;
  onQuotePress?: (_quote: PromotedQuote) => void;
  /** The quote the reader arrived to see, if it resolved. */
  focusedQuoteId: number | null;
}

/** Render one body segment: a note anchor, a promoted-quote span, or plain text. */
function renderAnchoredSlice(
  segment: AnchoredSegment,
  start: number,
  end: number,
  render: RenderContext,
): React.ReactNode {
  const { document, claimedAnchors, onOpen, onQuotePress, focusedQuoteId } = render;
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
        focused={quote.id === focusedQuoteId}
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
  render: RenderContext,
): React.ReactNode[] {
  const rendered: React.ReactNode[] = [];
  for (const segment of segments) {
    const slice = lineSlice(line, segment);
    if (slice === null) continue;
    rendered.push(renderAnchoredSlice(segment, slice.start, slice.end, render));
  }
  return rendered;
}

/** Render every line in a block, restoring only the line feeds between them. */
function renderBlockLines(
  block: JournalMarkdownBlock,
  segments: AnchoredSegment[],
  render: RenderContext,
): React.ReactNode[] {
  return block.lines.flatMap((line, index) => [
    ...(index === 0 ? [] : [`\n`]),
    ...bulletDecoration(block, line),
    ...renderLine(line, segments, render),
  ]);
}

/** Wrap a block's content in the element its kind calls for. */
function wrapBlock(block: JournalMarkdownBlock, content: React.ReactNode[]): React.JSX.Element {
  if (block.kind === 'quote') {
    return (
      <View
        role={webRole('blockquote')}
        accessibilityLabel="Quote block"
        style={styles.quoteBlock}
        testID={`journal-markdown-quote-${block.start}`}
      >
        <Text style={styles.body}>{content}</Text>
      </View>
    );
  }
  if (block.kind === 'bullet') {
    return (
      <View
        accessibilityLabel="List"
        style={styles.bulletBlock}
        testID={`journal-markdown-bullet-${block.start}`}
      >
        <Text style={styles.body}>{content}</Text>
      </View>
    );
  }
  return <Text style={styles.body}>{content}</Text>;
}

/** The start of the last block that begins at or before ``offset`` (the one holding it). */
function blockHolding(document: JournalMarkdownDocument, offset: number): number | null {
  let holding: number | null = null;
  for (const block of document.blocks) {
    if (block.start <= offset) holding = block.start;
  }
  return holding;
}

/**
 * Where a prose block splits so the focused quote's line starts the measured
 * half: the line holding ``offset``, walked back over any blank lines before
 * it. Those blank lines ride at the head of the second half as leading line
 * feeds, so the two halves stack exactly as the one block did -- a trailing
 * feed on the first half would collapse on the web and lose a line.
 */
function focusSplitIndex(block: JournalMarkdownBlock, offset: number): number {
  let index = 0;
  block.lines.forEach((line, i) => {
    if (line.start <= offset) index = i;
  });
  while (index > 0 && block.lines[index - 1]!.start === block.lines[index - 1]!.end) index -= 1;
  return index;
}

/**
 * A layout-neutral, measurable wrapper around the block holding the focused
 * quote. It reports its layout to the page's focus scroller, which measures it
 * against the page and scrolls it into view (see ``focusSpanScroll``).
 */
function FocusAnchor({
  focus,
  children,
}: {
  focus: FocusScrollValue;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = React.useRef<View>(null);
  const { onAnchorLayout } = focus;
  const onLayout = React.useCallback(() => {
    if (ref.current != null) onAnchorLayout(ref.current);
  }, [onAnchorLayout]);
  return (
    <View ref={ref} collapsable={false} testID="journal-focus-anchor" onLayout={onLayout}>
      {children}
    </View>
  );
}

/**
 * The block holding the focused quote, wrapped so it can be measured. A quote or
 * list block is wrapped whole (its container carries the styling); a prose
 * block -- which may be a whole long entry -- is split at the quote's line so
 * the measured anchor starts there rather than at the top of the entry.
 */
function renderFocusedBlock(
  block: JournalMarkdownBlock,
  segments: AnchoredSegment[],
  render: RenderContext,
  focus: NonNullable<BodyFocus>,
): React.ReactNode {
  const split =
    block.kind === 'quote' || block.kind === 'bullet'
      ? 0
      : focusSplitIndex(block, focus.span.start);
  const before = block.lines.slice(0, split);
  const from = { ...block, lines: block.lines.slice(split) };
  return (
    <>
      {before.length > 0
        ? wrapBlock(block, renderBlockLines({ ...block, lines: before }, segments, render))
        : null}
      <FocusAnchor focus={focus.scroll}>
        {wrapBlock(from, renderBlockLines(from, segments, render))}
      </FocusAnchor>
    </>
  );
}

/** Build the mixed prose/blockquote tree while assigning each anchor one primary ID. */
function renderDocumentBlocks(
  segments: AnchoredSegment[],
  render: RenderContext,
  focus: BodyFocus,
): React.ReactNode[] {
  const anchorBlock = focus == null ? null : blockHolding(render.document, focus.span.start);
  return render.document.blocks.map((block) => (
    <React.Fragment key={block.start}>
      {focus != null && block.start === anchorBlock
        ? renderFocusedBlock(block, segments, render, focus)
        : wrapBlock(block, renderBlockLines(block, segments, render))}
    </React.Fragment>
  ));
}

/** The focused quote's scroller and resolved span, or null when nothing is to be focused. */
type BodyFocus = { scroll: FocusScrollValue; span: ResolvedFocusSpan } | null;

/** Resolve the page's focus span (if any) against this body and its loaded quotes. */
function useBodyFocus(body: string, quotes: PromotedQuote[]): BodyFocus {
  const scroll = useFocusScroll();
  const span = resolveFocusSpan(body, scroll?.span, quotes);
  return scroll != null && span != null ? { scroll, span } : null;
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
  const detachedQuotes = React.useMemo(
    () => partitionQuotes(quotes, body).detached,
    [quotes, body],
  );
  const removeText = findRemoveQuoteText(segments, detachedQuotes, removeTargetId);
  const focus = useBodyFocus(body, quotes);
  const render: RenderContext = {
    document,
    claimedAnchors: new Set<string>(),
    onOpen,
    onQuotePress,
    focusedQuoteId: focus?.span.quoteId ?? null,
  };
  return (
    <>
      <BodyView
        accessible={false}
        style={styles.bodyContainer}
        testID="journal-body-read"
        onClick={removeTargetId != null ? onDismissRemove : undefined}
      >
        {renderDocumentBlocks(segments, render, focus)}
      </BodyView>
      <StaleQuoteNotes quotes={detachedQuotes} onQuotePress={onQuotePress} />
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
  bulletBlock: {
    paddingVertical: SPACING.xs,
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
  focused: {
    // The quote the reader came to see keeps its wash and gains a terracotta
    // underline, so it is findable at a glance without a louder colour.
    textDecorationLine: 'underline',
    textDecorationColor: accent.primary,
  },
});

export default HighlightedBody;
