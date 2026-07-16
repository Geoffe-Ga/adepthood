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

import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import { sourceAttribution } from './reflectionCopy';

import type { PromoteQuoteSpan, PromotedQuoteSummary, ReflectionSourceItem } from '@/api';
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

export interface ReflectionSourcesPanelProps {
  items: ReflectionSourceItem[];
  /**
   * Fold a pending quote into the reflection body. Resolves ``true`` when it was
   * marked included (keep the dim), ``false``/reject to revert the dim, or
   * ``undefined`` on a legacy fire-and-forget caller (keep the dim).
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

/** A single-line excerpt of a body for a collapsed row. */
function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX).trimEnd()}…` : flat;
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
      <Text style={styles.groupHeading}>Quotes to fold in</Text>
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
      <Text style={styles.body} testID={`source-body-${item.id}`}>
        {item.body}
      </Text>
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
}: {
  item: ReflectionSourceItem;
  expanded: boolean;
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
          <Text style={styles.levelLabel}>{levelLabel(item.reflection_level)}</Text>
        ) : null}
        <Text style={styles.rowTitle}>{sourceAttribution(item)}</Text>
        {expanded ? null : (
          <Text style={styles.rowExcerpt} numberOfLines={2}>
            {excerpt(item.body)}
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
}: {
  feed: ReflectionSourceItem[];
  onPromoteSpan?: PromoteSpanHandler;
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
          />
        );
      })}
    </View>
  );
}

/**
 * Own the "which pending quotes are folded in" dim and reconcile it with the
 * fold-in outcome: dim on tap, revert on a ``false``/rejected result, keep the
 * dim on ``true`` or a legacy fire-and-forget (``undefined``) caller.
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
      if (outcome == null) return; // Legacy fire-and-forget caller: keep the dim.
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

/** The panel's inner content, shared by the sheet and pane containers. */
function SourcesContent({
  items,
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
      {onClose == null ? null : (
        <TouchableOpacity
          style={styles.action}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the sources"
          testID="reflection-sources-close"
        >
          <Text style={styles.actionLink}>Done</Text>
        </TouchableOpacity>
      )}
      <PendingQuotesGroup pending={pending} includedIds={includedIds} onInsert={onInsert} />
      <SourceFeed feed={feed} onPromoteSpan={onPromoteSpan} />
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
  groupHeading: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
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
  levelLabel: {
    ...editorialType.caption,
    color: accent.strong,
    textTransform: 'uppercase',
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
  action: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  actionLink: {
    ...editorialType.action,
    color: accent.primary,
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
