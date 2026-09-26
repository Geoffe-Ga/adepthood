/**
 * ``ReflectionSourcesPanel`` — the rereadable sources feed beside a reflection.
 *
 * Two stacked regions:
 *   1. Pending promoted quotes (across every source) rise to the top so the
 *      reader can fold a remembered passage into the reflection with one tap.
 *      A folded quote dims and stays (a gentle "already used" trace), never
 *      vanishing under the reader's finger.
 *   2. The chronological feed (oldest → newest) of the entries and earlier
 *      reflections in scope. Each row collapses to an excerpt and expands to its
 *      full body on tap.
 *
 * Responsive per the margin-column precedent: a bottom-sheet ``Modal`` on a
 * narrow viewport, an inline side pane on a wide one. Reduced-motion safe.
 */
import { X } from 'lucide-react-native';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { excerpt } from './excerpt';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import ReadOnlyMarkdownText from './ReadOnlyMarkdownText';
import {
  formatReviewPeriod,
  sourceAttribution,
  sourceDateLabel,
  type ReviewWindow,
} from './reflectionCopy';
import { CLOSE_ICON_SIZE } from './ReflectionDismiss';

import type {
  PromoteQuoteSpan,
  PromotedQuoteSummary,
  ReflectionAnchorStatus,
  ReflectionSourceItem,
} from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** Below this viewport width the panel is a bottom sheet; at/above it, a side pane. */
const NARROW_BREAKPOINT = 600;

/** Collapsed-row excerpt length before an ellipsis. */
const EXCERPT_MAX = 120;

/** Warm left rule marking a pending quote / a reflection row, in dp. */
const STRIPE_WIDTH = 3;

/** Dim a pending quote once it has been folded into the reflection body. */
const INCLUDED_ROW_OPACITY = 0.5;

/** Warm, declinable copy when a re-promotion didn't take; invites a calm retry. */
const PROMOTE_FAILURE_HINT =
  'That selection didn’t quite take — you can try again whenever you like.';

/** The period is known, the feed settled, and it simply held nothing. */
const EMPTY_FEED_COPY = 'Nothing was written in this period.';

/** Still asking. Says what is happening, and claims nothing about the period. */
const LOADING_FEED_COPY = 'Gathering what you wrote then\u2026';

/**
 * The request did not land -- offline, a 500, a refused scope. The one thing
 * this must not do is read as an answer: nothing came back, so nothing is known
 * about what was written, and saying "nothing was written in this period" here
 * would be a claim the reader has no way to check.
 */
const FAILED_FEED_COPY =
  'These sources couldn\u2019t be loaded just now. Your writing is safe \u2014 close this and open it again whenever you like.';

/**
 * The period itself is gone. Beginning again used to overwrite the calendar
 * anchor of the cycle being left behind, so for a lap closed before that was
 * fixed there is no way to know which days this review covered. The copy is
 * careful to separate the two losses: the writing is safe, only the mapping
 * from this review back to its week is not, and no date is invented to paper
 * over it.
 */
const UNRECORDED_PERIOD_COPY =
  'The dates this review covered cannot be reconstructed — that was lost when you began ' +
  'again. Everything you wrote then is still in your journal, just not gathered here.';

/**
 * How far the sources request has got. Distinct from ``anchorStatus``, which
 * only means anything once a response has actually arrived: a feed that is
 * still in flight, or that failed, knows nothing about the period at all.
 */
export type SourcesFeedStatus = 'loading' | 'ready' | 'failed';

export interface ReflectionSourcesPanelProps {
  items: ReflectionSourceItem[];
  /**
   * Whether the feed has settled. Defaults to ``'ready'`` for the callers that
   * hand over an already-resolved list; the screen passes the live value, so an
   * in-flight or failed fetch never renders as a period the writer left empty.
   */
  feedStatus?: SourcesFeedStatus;
  /**
   * Why the server drew the window it drew, when it is worth saying. Only
   * ``'unrecorded'`` changes what the reader sees: it names a past cycle whose
   * calendar anchor was destroyed by beginning again, whose period therefore
   * cannot be rebuilt. Every other value — and ``undefined``, from a server that
   * predates the field — leaves an empty feed reading as the ordinary "nothing
   * was written then", which is the safer thing to say when unsure.
   */
  anchorStatus?: ReflectionAnchorStatus;
  /**
   * The period this review covers, as the server reported it on the sources
   * response. Absent when the server declared none (a caller with no program
   * anchor, or an older server), in which case no period is shown — never a
   * period the client worked out for itself, which could disagree with the feed
   * printed beneath it.
   */
  window?: ReviewWindow;
  /**
   * The account's IANA zone, used for every date this panel PRINTS. The server
   * windowed the feed on this zone, so formatting in the device's instead can
   * show a day boundary the feed below disagrees with. Absent falls back to the
   * device zone.
   */
  timeZone?: string;
  /**
   * Fold a pending quote into the reflection body. Resolves ``true`` when it was
   * marked included (keep the dim), ``false``/reject to revert the dim. May
   * return nothing, in which case no confirmation state is shown.
   */
  onInsertQuote: (
    _quote: PromotedQuoteSummary,
    _sourceItem: ReflectionSourceItem,
  ) => Promise<boolean> | undefined;
  /** Re-promote a freshly selected span of a source; resolves ``true`` on success. */
  onPromoteSpan?: (_sourceItem: ReflectionSourceItem, _span: PromoteQuoteSpan) => Promise<boolean>;
  onClose?: () => void;
}

/** One pending quote paired with the source it came from. */
interface PendingEntry {
  quote: PromotedQuoteSummary;
  item: ReflectionSourceItem;
}

/** Warm, sentence-case label for a reflection row's level (e.g. "Week reflection"). */
function levelLabel(level: string | null): string {
  if (!level) return 'Reflection';
  return `${level.charAt(0).toUpperCase()}${level.slice(1)} reflection`;
}

/** Feed order: oldest → newest by timestamp. */
function byTimestamp(a: ReflectionSourceItem, b: ReflectionSourceItem): number {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

/** A copy of ``ids`` with ``id`` added (the optimistic dim). */
function withId(ids: ReadonlySet<number>, id: number): Set<number> {
  return new Set(ids).add(id);
}

/** A copy of ``ids`` with ``id`` removed (reverting a failed fold-in's dim). */
function withoutId(ids: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/** A copy of ``keys`` with ``key`` toggled (expand/collapse a row). */
function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The pending quotes across every source (deduped by id), in source order. */
function collectPending(items: ReflectionSourceItem[]): PendingEntry[] {
  const pending: PendingEntry[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    for (const quote of item.promoted_quotes) {
      if (!quote.pending || seen.has(quote.id)) continue;
      seen.add(quote.id);
      pending.push({ quote, item });
    }
  }
  return pending;
}

/** One tappable pending quote; dims to an "already folded in" trace once inserted. */
function PendingQuoteRow({
  entry,
  included,
  onInsert,
}: {
  entry: PendingEntry;
  included: boolean;
  onInsert: (_e: PendingEntry) => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.pendingRow, included && styles.pendingRowIncluded]}
      onPress={() => {
        if (!included) onInsert(entry);
      }}
      accessibilityRole="button"
      accessibilityState={{ disabled: included }}
      accessibilityLabel={`Fold the quote "${entry.quote.anchor_text}" into your reflection`}
      testID={`pending-quote-${entry.quote.id}`}
    >
      <Text style={styles.pendingText} numberOfLines={2}>
        {entry.quote.anchor_text}
      </Text>
    </TouchableOpacity>
  );
}

/** The pending-quotes group above the feed; renders nothing when empty. */
function PendingQuotesGroup({
  pending,
  includedIds,
  onInsert,
}: {
  pending: PendingEntry[];
  includedIds: ReadonlySet<number>;
  onInsert: (_e: PendingEntry) => void;
}): React.JSX.Element | null {
  if (pending.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={[styles.eyebrow, styles.groupEyebrowSpacing]}>Quotes to fold in</Text>
      {pending.map((entry) => (
        <PendingQuoteRow
          key={entry.quote.id}
          entry={entry}
          included={includedIds.has(entry.quote.id)}
          onInsert={onInsert}
        />
      ))}
    </View>
  );
}

/** The gesture wiring an expanded row hands to its promote opener / selection. */
interface RowPromoteControls {
  /** True when this row currently owns the shared selection surface. */
  selecting: boolean;
  /** True when this row's last re-promotion could not be saved. */
  promoteFailed: boolean;
  /** True when re-promotion is available at all (the parent wired a handler). */
  canPromote: boolean;
  onStartSelecting: () => void;
  onSelectionChange: (_span: CodePointSpan) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** An expanded row's body — either the read-only text or the selection surface. */
function SourceExpansion({
  item,
  controls,
}: {
  item: ReflectionSourceItem;
  controls: RowPromoteControls;
}): React.JSX.Element {
  if (controls.selecting) {
    return (
      <QuoteSelectionSurface
        body={item.body}
        onSelectionChange={controls.onSelectionChange}
        onConfirm={controls.onConfirm}
        onCancel={controls.onCancel}
        testID={`source-select-${item.kind}-${item.id}`}
      />
    );
  }
  return (
    <>
      <ReadOnlyMarkdownText
        body={item.body}
        style={styles.body}
        testID={`source-body-${item.id}`}
      />
      {controls.canPromote ? (
        <TouchableOpacity
          style={styles.promoteOpener}
          onPress={controls.onStartSelecting}
          accessibilityRole="button"
          accessibilityLabel="Promote a passage from this source"
          testID={`source-promote-${item.kind}-${item.id}`}
        >
          <Text style={styles.promoteOpenerLink}>Promote a quote</Text>
        </TouchableOpacity>
      ) : null}
    </>
  );
}

/** One source in the feed: a header + excerpt, expanding to the full body on tap. */
function SourceRow({
  item,
  expanded,
  onToggle,
  controls,
  timeZone,
}: {
  item: ReflectionSourceItem;
  expanded: boolean;
  timeZone?: string;
  onToggle: () => void;
  controls: RowPromoteControls;
}): React.JSX.Element {
  const isReflection = item.kind === 'reflection';
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.rowHeader, isReflection && styles.rowHeaderReflection]}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${sourceAttribution(item)}`}
        testID={`${item.kind}-source-${item.id}`}
      >
        {isReflection ? (
          <Text style={styles.eyebrow}>{levelLabel(item.reflection_level)}</Text>
        ) : null}
        <Text style={styles.rowTitle}>{sourceAttribution(item)}</Text>
        <Text style={styles.rowDate} testID={`source-date-${item.id}`}>
          {sourceDateLabel(item, timeZone)}
        </Text>
        {expanded ? null : (
          <Text style={styles.rowExcerpt} numberOfLines={2}>
            {excerpt(item.body, EXCERPT_MAX)}
          </Text>
        )}
      </TouchableOpacity>
      {expanded ? <SourceExpansion item={item} controls={controls} /> : null}
      {controls.promoteFailed ? (
        <Text style={styles.promoteHint} testID="source-promote-hint">
          {PROMOTE_FAILURE_HINT}
        </Text>
      ) : null}
    </View>
  );
}

/** A char-offset span (defaults to empty so a bare confirm promotes nothing). */
type SelectionSpan = { start: number; end: number };

/** A re-promotion span handler; absent when the parent doesn't offer it. */
type PromoteSpanHandler = (
  _item: ReflectionSourceItem,
  _span: PromoteQuoteSpan,
) => Promise<boolean>;

/** The single-row selection state the feed threads down to its rows. */
interface RowSelection {
  selectingKey: string | null;
  promoteFailedKey: string | null;
  onSelectionChange: (_span: CodePointSpan) => void;
  startSelecting: (_key: string) => void;
  cancelSelecting: () => void;
  confirmSelection: (_item: ReflectionSourceItem, _key: string) => Promise<void>;
}

/**
 * Own the one row that currently holds the shared selection surface and the one
 * whose last re-promotion failed. Only one row selects at a time, so a single
 * key + a single captured span suffice.
 */
function useRowSelection(onPromoteSpan?: PromoteSpanHandler): RowSelection {
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [promoteFailedKey, setPromoteFailedKey] = useState<string | null>(null);
  const selectionRef = useRef<SelectionSpan>({ start: 0, end: 0 });

  const startSelecting = useCallback((key: string) => {
    selectionRef.current = { start: 0, end: 0 };
    setPromoteFailedKey(null);
    setSelectingKey(key);
  }, []);

  const cancelSelecting = useCallback(() => setSelectingKey(null), []);

  // The surface hands back an already-converted code-point span; store it so the
  // confirm handler posts anchors in the API's code-point unit.
  const onSelectionChange = useCallback((span: CodePointSpan) => {
    selectionRef.current = span;
  }, []);

  const confirmSelection = useCallback(
    async (item: ReflectionSourceItem, key: string): Promise<void> => {
      const { start, end } = selectionRef.current;
      setSelectingKey(null);
      if (onPromoteSpan == null) return;
      const ok = await onPromoteSpan(item, { anchor_start: start, anchor_end: end });
      if (!ok) setPromoteFailedKey(key);
    },
    [onPromoteSpan],
  );

  return {
    selectingKey,
    promoteFailedKey,
    onSelectionChange,
    startSelecting,
    cancelSelecting,
    confirmSelection,
  };
}

/** Bind the shared selection state to one row's promote controls. */
function buildControls(
  item: ReflectionSourceItem,
  key: string,
  canPromote: boolean,
  selection: RowSelection,
): RowPromoteControls {
  return {
    selecting: selection.selectingKey === key,
    promoteFailed: selection.promoteFailedKey === key,
    canPromote,
    onStartSelecting: () => selection.startSelecting(key),
    onSelectionChange: selection.onSelectionChange,
    onConfirm: () => selection.confirmSelection(item, key),
    onCancel: selection.cancelSelecting,
  };
}

/** The chronological feed; owns which rows are expanded + the selection surface. */
function SourceFeed({
  feed,
  onPromoteSpan,
  timeZone,
}: {
  feed: ReflectionSourceItem[];
  onPromoteSpan?: PromoteSpanHandler;
  timeZone?: string;
}): React.JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => toggleKey(prev, key));
  }, []);
  const selection = useRowSelection(onPromoteSpan);
  const canPromote = onPromoteSpan != null;
  return (
    <View>
      {feed.map((item) => {
        const key = `${item.kind}-${item.id}`;
        return (
          <SourceRow
            key={key}
            item={item}
            expanded={expandedKeys.has(key)}
            onToggle={() => toggle(key)}
            controls={buildControls(item, key, canPromote, selection)}
            timeZone={timeZone}
          />
        );
      })}
    </View>
  );
}

/**
 * Own the "which pending quotes are folded in" dim and reconcile it with the
 * fold-in outcome: dim on tap, revert on a ``false``/rejected result, keep the
 * dim on ``true`` or when no outcome is reported (skip the confirmation state).
 */
function useDimReconciler(onInsertQuote: ReflectionSourcesPanelProps['onInsertQuote']): {
  includedIds: ReadonlySet<number>;
  onInsert: (_entry: PendingEntry) => void;
} {
  const [includedIds, setIncludedIds] = useState<ReadonlySet<number>>(() => new Set<number>());

  const reconcileInsert = useCallback(
    async (entry: PendingEntry): Promise<void> => {
      const { id } = entry.quote;
      setIncludedIds((prev) => withId(prev, id)); // Dim optimistically.
      const outcome = onInsertQuote(entry.quote, entry.item);
      if (outcome == null) return; // No outcome reported — skip the confirmation state.
      let foldedIn = false;
      try {
        foldedIn = await outcome;
      } catch {
        foldedIn = false; // A rejected fold-in reverts the dim, like a false.
      }
      if (!foldedIn) setIncludedIds((prev) => withoutId(prev, id));
    },
    [onInsertQuote],
  );

  const onInsert = useCallback(
    (entry: PendingEntry): void => {
      void reconcileInsert(entry);
    },
    [reconcileInsert],
  );

  return { includedIds, onInsert };
}

/**
 * The panel's heading row: "Sources" (with, when the server declared one, the
 * period the review covers beneath it — rendered from ``window`` alone, see
 * {@link formatReviewPeriod}) on the left, and in the trailing slot an
 * icon-only X that closes the sheet. The X is the word "Done" as a glyph, so it
 * keeps that word as its accessible name; a pane caller that passes no
 * ``onClose`` gets the heading without it.
 */
function SourcesHeading({
  window: reviewWindow,
  timeZone,
  onClose,
}: {
  window?: ReviewWindow;
  timeZone?: string;
  onClose?: () => void;
}): React.JSX.Element {
  const period =
    reviewWindow == null ? '' : formatReviewPeriod(reviewWindow.start, reviewWindow.end, timeZone);
  return (
    <View style={styles.heading} testID="reflection-sources-heading">
      <View style={styles.headingText}>
        <Text style={styles.headingTitle} accessibilityRole="header">
          Sources
        </Text>
        {period === '' ? null : (
          <Text style={styles.headingPeriod} testID="reflection-sources-period">
            {period}
          </Text>
        )}
      </View>
      {onClose == null ? null : (
        <TouchableOpacity
          style={styles.closeControl}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          testID="reflection-sources-close"
        >
          <X color={ink.soft} size={CLOSE_ICON_SIZE} accessible={false} />
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * What stands where the feed would be when there is no feed.
 *
 * Two different silences, told apart on purpose. "Nothing was written in this
 * period" is a fact about the reader's own week. "These dates cannot be
 * reconstructed" is a fact about the app, and collapsing the second into the
 * first would quietly tell someone they wrote nothing during a stretch they may
 * well have written through every day of.
 */
function EmptyFeed({
  anchorStatus,
  feedStatus,
}: {
  anchorStatus?: ReflectionAnchorStatus;
  feedStatus: SourcesFeedStatus;
}): React.JSX.Element {
  // The fetch's own state is asked FIRST and wins outright. ``anchorStatus``
  // describes a period, and there is no period to describe until a response has
  // arrived -- so an in-flight or failed feed must never fall through to copy
  // that states something about what the writer wrote.
  if (feedStatus === 'loading') {
    return (
      <Text style={styles.emptyCopy} testID="reflection-sources-loading">
        {LOADING_FEED_COPY}
      </Text>
    );
  }
  if (feedStatus === 'failed') {
    return (
      <Text style={styles.emptyCopy} testID="reflection-sources-unavailable">
        {FAILED_FEED_COPY}
      </Text>
    );
  }
  if (anchorStatus === 'unrecorded') {
    return (
      <Text style={styles.emptyCopy} testID="reflection-sources-unrecorded">
        {UNRECORDED_PERIOD_COPY}
      </Text>
    );
  }
  return (
    <Text style={styles.emptyCopy} testID="reflection-sources-empty">
      {EMPTY_FEED_COPY}
    </Text>
  );
}

/** The panel's inner content, shared by the sheet and pane containers. */
function SourcesContent({
  items,
  window: reviewWindow,
  timeZone,
  anchorStatus,
  feedStatus = 'ready',
  onInsertQuote,
  onPromoteSpan,
  onClose,
}: ReflectionSourcesPanelProps): React.JSX.Element {
  const pending = useMemo(() => collectPending(items), [items]);
  const feed = useMemo(() => [...items].sort(byTimestamp), [items]);
  const { includedIds, onInsert } = useDimReconciler(onInsertQuote);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <SourcesHeading window={reviewWindow} timeZone={timeZone} onClose={onClose} />
      <PendingQuotesGroup pending={pending} includedIds={includedIds} onInsert={onInsert} />
      {feed.length === 0 ? (
        <EmptyFeed anchorStatus={anchorStatus} feedStatus={feedStatus} />
      ) : (
        <SourceFeed feed={feed} onPromoteSpan={onPromoteSpan} timeZone={timeZone} />
      )}
    </ScrollView>
  );
}

function ReflectionSourcesPanel(props: ReflectionSourcesPanelProps): React.JSX.Element {
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  const reducedMotion = useReducedMotion();

  if (narrow) {
    return (
      <Modal
        visible
        transparent
        animationType={reducedMotion ? 'none' : 'slide'}
        onRequestClose={props.onClose}
        testID="reflection-sources-sheet"
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <SourcesContent {...props} />
          </View>
        </View>
      </Modal>
    );
  }
  return (
    <View style={styles.pane} testID="reflection-sources-pane">
      <SourcesContent {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  pane: {
    // The editor's timer and resonance controls are intentionally absolute.
    // Keep the open source surface in a higher stacking context so those
    // background controls cannot absorb taps meant for quotes in the panel.
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxHeight: '100%',
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    ...surfaceShadow.card,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.mystical.overlay,
  },
  sheet: {
    maxHeight: '80%',
    backgroundColor: surface.raised,
    borderTopLeftRadius: BORDER_RADIUS.lg,
    borderTopRightRadius: BORDER_RADIUS.lg,
    ...surfaceShadow.raised,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    padding: SPACING.lg,
  },
  group: {
    marginBottom: SPACING.lg,
  },
  // The one eyebrow face in this sheet: the pending-quotes group heading and a
  // reflection row's level label both wear it.
  eyebrow: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
  },
  groupEyebrowSpacing: {
    marginBottom: SPACING.sm,
  },
  pendingRow: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.quoteHighlight,
    borderLeftWidth: STRIPE_WIDTH,
    borderLeftColor: accent.primary,
  },
  pendingRowIncluded: {
    opacity: INCLUDED_ROW_OPACITY,
  },
  pendingText: {
    ...editorialType.note,
    color: ink.primary,
  },
  row: {
    marginBottom: SPACING.md,
  },
  rowHeader: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingVertical: SPACING.sm,
  },
  rowHeaderReflection: {
    borderLeftWidth: STRIPE_WIDTH,
    borderLeftColor: accent.strong,
    paddingLeft: SPACING.md,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: spacing(1),
  },
  headingText: {
    flex: 1,
  },
  closeControl: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headingTitle: {
    ...editorialType.note,
    color: ink.primary,
    fontWeight: '600',
  },
  headingPeriod: {
    ...editorialType.caption,
    color: ink.soft,
    paddingTop: spacing(0.25),
  },
  emptyCopy: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(1),
  },
  rowDate: {
    ...editorialType.caption,
    color: ink.soft,
  },
  rowTitle: {
    ...editorialType.note,
    color: ink.primary,
    fontWeight: '600',
  },
  rowExcerpt: {
    ...editorialType.caption,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  body: {
    ...editorialType.body,
    color: ink.primary,
    paddingTop: spacing(1),
  },
  promoteOpener: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingTop: spacing(1),
  },
  promoteOpenerLink: {
    ...editorialType.action,
    color: accent.primary,
  },
  promoteHint: {
    ...editorialType.caption,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
});

export default ReflectionSourcesPanel;
