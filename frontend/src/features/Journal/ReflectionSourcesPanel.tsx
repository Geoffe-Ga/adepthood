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
import React, { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { sourceAttribution } from './reflectionCopy';

import type { PromotedQuoteSummary, ReflectionSourceItem } from '@/api';
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

export interface ReflectionSourcesPanelProps {
  items: ReflectionSourceItem[];
  onInsertQuote: (_quote: PromotedQuoteSummary, _sourceItem: ReflectionSourceItem) => void;
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

/** One source in the feed: a header + excerpt, expanding to the full body on tap. */
function SourceRow({
  item,
  expanded,
  onToggle,
}: {
  item: ReflectionSourceItem;
  expanded: boolean;
  onToggle: () => void;
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
      {expanded ? (
        <Text style={styles.body} testID={`source-body-${item.id}`}>
          {item.body}
        </Text>
      ) : null}
    </View>
  );
}

/** The chronological feed; owns which rows are expanded. */
function SourceFeed({ feed }: { feed: ReflectionSourceItem[] }): React.JSX.Element {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
          />
        );
      })}
    </View>
  );
}

/** The panel's inner content, shared by the sheet and pane containers. */
function SourcesContent({
  items,
  onInsertQuote,
  onClose,
}: ReflectionSourcesPanelProps): React.JSX.Element {
  const [includedIds, setIncludedIds] = useState<ReadonlySet<number>>(() => new Set<number>());
  const pending = useMemo(() => collectPending(items), [items]);
  const feed = useMemo(() => [...items].sort(byTimestamp), [items]);

  const onInsert = useCallback(
    (entry: PendingEntry) => {
      setIncludedIds((prev) => new Set(prev).add(entry.quote.id));
      onInsertQuote(entry.quote, entry.item);
    },
    [onInsertQuote],
  );

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
      <SourceFeed feed={feed} />
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
    ...editorialType.caption,
    color: accent.primary,
    fontWeight: '600',
  },
});

export default ReflectionSourcesPanel;
