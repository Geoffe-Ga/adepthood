/**
 * ``ReflectionSourcesPanel`` — the rereadable sources feed beside a reflection.
 *
 * Two stacked regions:
 *   1. Pending promoted quotes (across every source) rise to the top so the
 *      reader can fold a remembered passage into the reflection with one tap.
 *      A folded quote dims and stays (a gentle "already used" trace), never
 *      vanishing under the reader's finger. "Select quotes" turns the rows into
 *      checkboxes instead, and one fixed action beneath the scroll folds every
 *      checked quote in as a single batch (#2885). Quotes of what the writer
 *      READ -- Course chapters and Resonance Letters, which have no entry in
 *      the feed to belong to -- follow under "From your reading", each
 *      captioned with where it came from, and fold the same way (#3659).
 *   2. The chronological feed (oldest → newest) of the entries and earlier
 *      reflections in scope. Each row collapses to an excerpt and expands to its
 *      full body on tap.
 *
 * Responsive, and a ``Modal`` at every width: below ``CENTRED_MODAL_BREAKPOINT`` a
 * bounded bottom sheet the width of the page; from it up, a card at the page's
 * reading measure centred over the dimmed desk (#3133), never a sliver beside
 * the writing. Either way a tap on the backdrop, Escape, the platform back
 * button or the X closes it, and the heading and its X stay fixed above a scroll
 * holding only the quotes and the feed (#2883). Reduced-motion safe.
 */
import { X } from 'lucide-react-native';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';

import { excerpt } from './excerpt';
import { candidateFromReadingQuote, candidateFromSource, type FoldCandidate } from './quoteBatch';
import { FOLDED_SUFFIX, foldQuoteA11y, foldSelectedLabel, selectQuoteA11y } from './quoteFoldCopy';
import { QUOTE_STRIPE_WIDTH, QuoteRow } from './QuoteRow';
import { QuoteFoldBar, SelectionHeader } from './QuoteSelectionControls';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import ReadOnlyMarkdownText from './ReadOnlyMarkdownText';
import {
  formatReviewPeriod,
  quoteSourceCaption,
  sourceAttribution,
  sourceDateLabel,
  type ReviewWindow,
} from './reflectionCopy';
import { CLOSE_ICON_SIZE } from './ReflectionDismiss';
import { useQuoteSelection, type QuoteSelection } from './useQuoteSelection';
import type { BatchFoldResult } from './useReflectionMode';

import type {
  PromoteQuoteSpan,
  PromotedQuoteSummary,
  ReadingQuoteItem,
  ReflectionAnchorStatus,
  ReflectionSourceItem,
} from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  contentLayout,
  editorialType,
  ink,
  journalLayout,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * At/above this viewport width the panel opens as a card centred over the desk;
 * below it, as a bounded bottom sheet (#3133). The sheet is as wide as the page
 * (``contentLayout.maxWidth``: the reading measure plus its 220 margin column),
 * so below this it still spans the page a writer is reading beside. From here
 * up the desk is wide enough that a page-wide sheet would strand the sources
 * along the bottom edge, so the panel comes forward as a card at the reading
 * measure instead. The value -- the page plus half a reading measure, where the
 * retired side pane used to begin -- is kept so no width below it changes.
 */
export const CENTRED_MODAL_BREAKPOINT = contentLayout.maxWidth + journalLayout.pageMaxWidth / 2;

/** The sheet never covers more than this share of the viewport's height. */
const SHEET_MAX_HEIGHT = '80%';

/**
 * The centred card never covers more than this share of the viewport's height:
 * taller than the sheet, since it rises from neither edge, yet leaving a band of
 * dimmed desk above and below to tap away on.
 */
const MODAL_MAX_HEIGHT = '90%';

/** The dialog's accessible name: what the heading says the panel holds. */
const SOURCES_DIALOG_LABEL = 'Sources';

/**
 * On native, the in-panel selection field is capped at this share of the
 * window's height and scrolls inside, so a long source cannot push "Promote
 * selection" and "Cancel" out of the sheet. Web needs no cap: its actions
 * footer is sticky to the panel's scroller.
 */
const SELECTION_FIELD_HEIGHT_FRACTION = 0.35;

/** The native selection field's cap for this window height; none on web. */
function selectionFieldCap(windowHeight: number): number | undefined {
  if (Platform.OS === 'web') return undefined;
  return Math.round(windowHeight * SELECTION_FIELD_HEIGHT_FRACTION);
}

/** Collapsed-row excerpt length before an ellipsis. */
const EXCERPT_MAX = 120;

/** Warm left rule marking a reflection row, the same weight as a quote's stripe. */
const STRIPE_WIDTH = QUOTE_STRIPE_WIDTH;

/** The sub-group of Course and letter quotes, beneath the entries' own quotes (#3659). */
export const READING_QUOTES_LABEL = 'From your reading';

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
  'We can’t tell which dates this review covered — that was lost when you began again. ' +
  'Everything you wrote then is still in your journal, just not gathered here.';

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
  /**
   * The Course and letter quotes promoted inside the window (#3659). Only the
   * pending ones are offered, under "From your reading".
   */
  readingQuotes?: readonly ReadingQuoteItem[];
  /**
   * Fold one of ``readingQuotes`` in; resolves like ``onInsertQuote``. Absent,
   * a reading quote can still be checked and folded in a batch.
   */
  onInsertReadingQuote?: (_quote: ReadingQuoteItem) => Promise<boolean> | undefined;
  /**
   * Fold a whole selection in as one batch (#2885). Absent, the panel offers
   * no selection mode and a tap folds one quote at a time, as it always has.
   */
  onInsertQuotes?: (_candidates: readonly FoldCandidate[]) => Promise<BatchFoldResult>;
  /**
   * Quotes the composer has already folded in and marked, by any route -- a
   * hand-off from the Promoted quotes screen included -- shown folded here.
   */
  foldedIds?: ReadonlySet<number>;
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

/** A copy of ``ids`` with every one of ``more`` added (a batch's optimistic dim). */
function withIds(ids: ReadonlySet<number>, more: readonly number[]): Set<number> {
  return new Set([...ids, ...more]);
}

/** A copy of ``ids`` with every one of ``gone`` removed (reverting failed dims). */
function withoutIds(ids: ReadonlySet<number>, gone: readonly number[]): Set<number> {
  const next = new Set(ids);
  for (const id of gone) next.delete(id);
  return next;
}

/** A copy of ``keys`` with ``key`` toggled (expand/collapse a row). */
function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The reading quotes still waiting to be folded, in the order the server sent them. */
function pendingReading(quotes: readonly ReadingQuoteItem[] | undefined): ReadingQuoteItem[] {
  return (quotes ?? []).filter((quote) => quote.pending);
}

/**
 * Every quote the panel can fold, as candidates, in the panel's own order: the
 * entries' quotes in source order, then the reading quotes. Selection mode
 * folds a batch in exactly this order.
 */
function foldOrder(pending: readonly PendingEntry[], reading: readonly ReadingQuoteItem[]) {
  return [
    ...pending.map((entry) => candidateFromSource(entry.quote, entry.item)),
    ...reading.map(candidateFromReadingQuote),
  ];
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

/**
 * One pending quote. Outside selection mode a tap folds it in; inside, it is a
 * checkbox and a tap checks it. Once folded it dims, takes a check glyph and
 * says so in its name (#2952) -- carried as ``disabled``, never as ``selected``
 * or ``checked``, which belong to the selection.
 */
function PendingQuoteRow({
  entry,
  included,
  selection,
  onInsert,
}: {
  entry: PendingEntry;
  included: boolean;
  selection: QuoteSelection;
  onInsert: (_e: PendingEntry) => void;
}): React.JSX.Element {
  const { id, anchor_text: text } = entry.quote;
  const checkable = selection.selecting && !included;
  const onPress = (): void => {
    if (included) return;
    if (checkable) selection.toggle(id);
    else onInsert(entry);
  };
  return (
    <QuoteRow
      text={text}
      dimmed={included}
      marked={included}
      checked={checkable ? selection.selected.has(id) : undefined}
      onPress={onPress}
      accessibilityState={{ disabled: included }}
      accessibilityLabel={
        checkable ? selectQuoteA11y(text) : `${foldQuoteA11y(text)}${included ? FOLDED_SUFFIX : ''}`
      }
      testID={`pending-quote-${id}`}
    />
  );
}

/**
 * One quote from the writer's reading (#3659): the same row as an entry's
 * quote, captioned with where it came from -- ``From “Beige 1”``, ``From a
 * letter · Rain`` -- since no source row beneath names it. Folds, checks and
 * dims exactly as {@link PendingQuoteRow} does.
 */
function ReadingQuoteRow({
  quote,
  included,
  selection,
  onInsert,
}: {
  quote: ReadingQuoteItem;
  included: boolean;
  selection: QuoteSelection;
  onInsert: (_quote: ReadingQuoteItem) => void;
}): React.JSX.Element {
  const { id, anchor_text: text } = quote;
  const caption = quoteSourceCaption({
    kind: quote.source_kind,
    title: quote.source_title,
    timestamp: quote.created_at,
  });
  const checkable = selection.selecting && !included;
  const onPress = (): void => {
    if (included) return;
    if (checkable) selection.toggle(id);
    else onInsert(quote);
  };
  const name = checkable ? selectQuoteA11y(text) : foldQuoteA11y(text);
  return (
    <QuoteRow
      text={text}
      caption={caption}
      dimmed={included}
      marked={included}
      checked={checkable ? selection.selected.has(id) : undefined}
      onPress={onPress}
      accessibilityState={{ disabled: included }}
      // Label-in-name: the visible caption is part of what the row is called.
      accessibilityLabel={`${name}, ${caption}${included ? FOLDED_SUFFIX : ''}`}
      testID={`reading-quote-${id}`}
    />
  );
}

/** "From your reading": the Course and letter quotes, beneath the entries' own. */
function ReadingQuotesSubgroup({
  reading,
  includedIds,
  selection,
  onInsert,
}: {
  reading: readonly ReadingQuoteItem[];
  includedIds: ReadonlySet<number>;
  selection: QuoteSelection;
  onInsert: (_quote: ReadingQuoteItem) => void;
}): React.JSX.Element | null {
  if (reading.length === 0) return null;
  return (
    <View testID="reading-quotes">
      <Text style={styles.subgroupLabel} testID="reading-quotes-label">
        {READING_QUOTES_LABEL}
      </Text>
      {reading.map((quote) => (
        <ReadingQuoteRow
          key={quote.id}
          quote={quote}
          included={includedIds.has(quote.id)}
          selection={selection}
          onInsert={onInsert}
        />
      ))}
    </View>
  );
}

interface PendingQuotesGroupProps {
  pending: PendingEntry[];
  reading: readonly ReadingQuoteItem[];
  includedIds: ReadonlySet<number>;
  selection: QuoteSelection;
  canSelect: boolean;
  onInsert: (_e: PendingEntry) => void;
  onInsertReading: (_quote: ReadingQuoteItem) => void;
}

/** The pending-quotes group above the feed; renders nothing when empty. */
function PendingQuotesGroup({
  pending,
  reading,
  includedIds,
  selection,
  canSelect,
  onInsert,
  onInsertReading,
}: PendingQuotesGroupProps): React.JSX.Element | null {
  if (pending.length === 0 && reading.length === 0) return null;
  const selectable = foldOrder(pending, reading)
    .map((candidate) => candidate.id)
    .filter((id) => !includedIds.has(id));
  return (
    <View style={styles.group}>
      <Text style={[styles.eyebrow, styles.groupEyebrowSpacing]}>Quotes to fold in</Text>
      {canSelect ? (
        <SelectionHeader
          selecting={selection.selecting}
          onToggleMode={selection.toggleMode}
          onSelectAll={() => selection.selectAll(selectable)}
          onClear={selection.clear}
          testIDPrefix="pending-quotes"
        />
      ) : null}
      {pending.map((entry) => (
        <PendingQuoteRow
          key={entry.quote.id}
          entry={entry}
          included={includedIds.has(entry.quote.id)}
          selection={selection}
          onInsert={onInsert}
        />
      ))}
      <ReadingQuotesSubgroup
        reading={reading}
        includedIds={includedIds}
        selection={selection}
        onInsert={onInsertReading}
      />
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
  /** The passage already chosen, so a remounted surface picks up where it was. */
  selectedSpan: CodePointSpan;
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
  const windowHeight = useWindowDimensions().height;
  if (controls.selecting) {
    return (
      <QuoteSelectionSurface
        body={item.body}
        onSelectionChange={controls.onSelectionChange}
        onConfirm={controls.onConfirm}
        onCancel={controls.onCancel}
        testID={`source-select-${item.kind}-${item.id}`}
        maxFieldHeight={selectionFieldCap(windowHeight)}
        initialSelection={controls.selectedSpan}
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

/** Nothing chosen yet: a bare confirm promotes nothing. */
const EMPTY_SPAN: CodePointSpan = { start: 0, end: 0 };

/** A re-promotion span handler; absent when the parent doesn't offer it. */
type PromoteSpanHandler = (
  _item: ReflectionSourceItem,
  _span: PromoteQuoteSpan,
) => Promise<boolean>;

/** The single-row selection state the feed threads down to its rows. */
interface RowSelection {
  selectingKey: string | null;
  promoteFailedKey: string | null;
  span: CodePointSpan;
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
  // State, not a ref: a surface remounted mid-selection is seeded from it.
  const [span, setSpan] = useState<CodePointSpan>(EMPTY_SPAN);

  const startSelecting = useCallback((key: string) => {
    setSpan(EMPTY_SPAN);
    setPromoteFailedKey(null);
    setSelectingKey(key);
  }, []);

  const cancelSelecting = useCallback(() => setSelectingKey(null), []);

  // The surface hands back an already-converted code-point span; store it so the
  // confirm handler posts anchors in the API's code-point unit.
  const onSelectionChange = useCallback((next: CodePointSpan) => {
    setSpan(next);
  }, []);

  const confirmSelection = useCallback(
    async (item: ReflectionSourceItem, key: string): Promise<void> => {
      const { start, end } = span;
      setSelectingKey(null);
      if (onPromoteSpan == null) return;
      const ok = await onPromoteSpan(item, { anchor_start: start, anchor_end: end });
      if (!ok) setPromoteFailedKey(key);
    },
    [onPromoteSpan, span],
  );

  return {
    selectingKey,
    promoteFailedKey,
    span,
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
    selectedSpan: selection.span,
    onStartSelecting: () => selection.startSelecting(key),
    onSelectionChange: selection.onSelectionChange,
    onConfirm: () => selection.confirmSelection(item, key),
    onCancel: selection.cancelSelecting,
  };
}

/** Which rows are expanded, and the one row holding the selection surface. */
interface FeedState {
  expandedKeys: ReadonlySet<string>;
  toggle: (_key: string) => void;
  selection: RowSelection;
  canPromote: boolean;
}

/** Own the feed's expansion and selection state. */
function useFeedState(onPromoteSpan?: PromoteSpanHandler): FeedState {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => toggleKey(prev, key));
  }, []);
  const selection = useRowSelection(onPromoteSpan);
  return { expandedKeys, toggle, selection, canPromote: onPromoteSpan != null };
}

/** The chronological feed, rendered from state its caller owns. */
function SourceFeed({
  feed,
  state,
  timeZone,
}: {
  feed: ReflectionSourceItem[];
  state: FeedState;
  timeZone?: string;
}): React.JSX.Element {
  const { expandedKeys, toggle, selection, canPromote } = state;
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
function useDimReconciler(
  onInsertQuote: ReflectionSourcesPanelProps['onInsertQuote'],
  onInsertReadingQuote: ReflectionSourcesPanelProps['onInsertReadingQuote'],
): {
  includedIds: ReadonlySet<number>;
  setIncludedIds: Dispatch<SetStateAction<ReadonlySet<number>>>;
  onInsert: (_entry: PendingEntry) => void;
  onInsertReading: (_quote: ReadingQuoteItem) => void;
} {
  const [includedIds, setIncludedIds] = useState<ReadonlySet<number>>(() => new Set<number>());

  const reconcileInsert = useCallback(
    async (id: number, fold: () => Promise<boolean> | undefined): Promise<void> => {
      setIncludedIds((prev) => withIds(prev, [id])); // Dim optimistically.
      const outcome = fold();
      if (outcome == null) return; // No outcome reported — skip the confirmation state.
      let foldedIn = false;
      try {
        foldedIn = await outcome;
      } catch {
        foldedIn = false; // A rejected fold-in reverts the dim, like a false.
      }
      if (!foldedIn) setIncludedIds((prev) => withoutIds(prev, [id]));
    },
    [],
  );

  const onInsert = useCallback(
    (entry: PendingEntry): void => {
      void reconcileInsert(entry.quote.id, () => onInsertQuote(entry.quote, entry.item));
    },
    [reconcileInsert, onInsertQuote],
  );

  const onInsertReading = useCallback(
    (quote: ReadingQuoteItem): void => {
      if (onInsertReadingQuote == null) return;
      void reconcileInsert(quote.id, () => onInsertReadingQuote(quote));
    },
    [reconcileInsert, onInsertReadingQuote],
  );

  return { includedIds, setIncludedIds, onInsert, onInsertReading };
}

/**
 * What a batch left for the writer: its failed ids, and whether it took any
 * quote at all. A batch that threw took none and left every id failed. A quote
 * the server says is gone (#2754) was taken but is not failed, so it leaves the
 * selection and stays dimmed until the composer prunes its row from the feed.
 */
async function settleBatch(
  outcome: Promise<BatchFoldResult>,
  ids: readonly number[],
): Promise<{ failed: readonly number[]; admittedAny: boolean }> {
  try {
    const result = await outcome;
    return {
      failed: result.failed,
      admittedAny: result.included.length + result.failed.length + result.gone.length > 0,
    };
  } catch {
    return { failed: ids, admittedAny: true };
  }
}

/** The batch fold the panel's bar runs, and whether one is on the wire now. */
interface BatchFold {
  /** Fold the checked ones of ``candidates`` (every quote listed, in the panel's order). */
  onFoldSelected: (_candidates: readonly FoldCandidate[]) => void;
  folding: boolean;
}

/**
 * Fold the checked quotes in as one batch, in the panel's own order: dim them
 * all at once, then undim only the ones whose mark failed and leave exactly
 * those checked for another try.
 *
 * It reconciles only its OWN quotes (#2885 review): a quote the writer checks
 * while the batch is out stays checked, and a batch that took no quote at all
 * (every id already on the wire with another act, which reconciles its own
 * dim) leaves the selection exactly as it was. ``folding`` disables the bar
 * for the span, so a second press cannot race the first's reconciliation.
 */
function useBatchFold(
  onInsertQuotes: ReflectionSourcesPanelProps['onInsertQuotes'],
  selection: QuoteSelection,
  setIncludedIds: Dispatch<SetStateAction<ReadonlySet<number>>>,
): BatchFold {
  const { selected, settle } = selection;
  const [folding, setFolding] = useState(false);
  const foldChosen = useCallback(
    async (candidates: readonly FoldCandidate[]): Promise<void> => {
      if (onInsertQuotes == null) return;
      const chosen = candidates.filter((candidate) => selected.has(candidate.id));
      if (chosen.length === 0) return;
      const ids = chosen.map((candidate) => candidate.id);
      setFolding(true);
      setIncludedIds((prev) => withIds(prev, ids));
      const outcome = onInsertQuotes(chosen);
      const { failed, admittedAny } = await settleBatch(outcome, ids);
      setFolding(false);
      setIncludedIds((prev) => withoutIds(prev, failed));
      if (admittedAny) settle(ids, failed);
    },
    [onInsertQuotes, selected, settle, setIncludedIds],
  );
  const onFoldSelected = useCallback(
    (candidates: readonly FoldCandidate[]) => {
      void foldChosen(candidates);
    },
    [foldChosen],
  );
  return { onFoldSelected, folding };
}

/** The close control's host ref, which takes focus as the panel opens. */
type CloseControlRef = React.RefObject<React.ComponentRef<typeof TouchableOpacity> | null>;

/**
 * Move focus to the close control as the panel opens (#3002).
 *
 * The Sources toggle sits in the exit row, above the editor, so a Tab walk from
 * it would cross the whole page before reaching the dock. The panel mounts only
 * while open, so mounting IS opening. One frame late, so a web ``Modal`` has
 * attached its portal; cancelled if the panel closes first. Closing hands focus
 * back to the toggle (``useRestoreFocusOnClose``).
 */
function useFocusOnOpen(enabled: boolean): CloseControlRef {
  const ref = useRef<React.ComponentRef<typeof TouchableOpacity>>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const frame = requestAnimationFrame(() => ref.current?.focus?.());
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
  return ref;
}

/**
 * The panel's heading row: "Sources" (with, when the server declared one, the
 * period the review covers beneath it — rendered from ``window`` alone, see
 * {@link formatReviewPeriod}) on the left, and in the trailing slot an
 * icon-only X that closes the sheet. The X is the word "Done" as a glyph, so it
 * keeps that word as its accessible name, and takes focus as the panel opens; a
 * caller that passes no ``onClose`` gets the heading without it.
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
  const closeRef = useFocusOnOpen(onClose != null);
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
          ref={closeRef}
          style={styles.closeControl}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          testID="reflection-sources-close"
        >
          <X color={ink.soft} size={CLOSE_ICON_SIZE} {...decorativeHidden()} />
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

/**
 * Everything the reader has done in the panel. Owned ABOVE the container, so
 * whatever becomes of it -- crossing the breakpoint while open swaps the sheet
 * for the centred card (#2883, #3133) -- this is what the reader keeps.
 */
interface PanelState {
  feed: FeedState;
  /** Dimmed as folded: this panel's own folds, plus the composer's ``foldedIds``. */
  includedIds: ReadonlySet<number>;
  onInsert: (_entry: PendingEntry) => void;
  onInsertReading: (_quote: ReadingQuoteItem) => void;
  /** The checked quotes -- here, above the switch, so a resize keeps them (#2885). */
  selection: QuoteSelection;
  onFoldSelected: (_candidates: readonly FoldCandidate[]) => void;
  /** True while this panel's batch is on the wire; the bar rests meanwhile. */
  folding: boolean;
}

function usePanelState(props: ReflectionSourcesPanelProps): PanelState {
  const feed = useFeedState(props.onPromoteSpan);
  const dims = useDimReconciler(props.onInsertQuote, props.onInsertReadingQuote);
  const selection = useQuoteSelection();
  // A checked quote can leave the feed while it waits -- the composer prunes a
  // quote removed elsewhere (#2754) -- so the selection narrows to what is still
  // listed, and the bar never counts, or offers to fold, a row that is gone.
  const { keepOnly } = selection;
  const { items, readingQuotes } = props;
  useEffect(() => {
    const listed = foldOrder(collectPending(items), pendingReading(readingQuotes));
    keepOnly(listed.map((candidate) => candidate.id));
  }, [items, readingQuotes, keepOnly]);
  const { onFoldSelected, folding } = useBatchFold(
    props.onInsertQuotes,
    selection,
    dims.setIncludedIds,
  );
  const { foldedIds } = props;
  const own = dims.includedIds;
  const includedIds = useMemo(
    () => (foldedIds == null || foldedIds.size === 0 ? own : withIds(own, [...foldedIds])),
    [own, foldedIds],
  );
  return {
    feed,
    includedIds,
    onInsert: dims.onInsert,
    onInsertReading: dims.onInsertReading,
    selection,
    onFoldSelected,
    folding,
  };
}

/** The props every container hands its content: the caller's, plus the lifted state. */
type ContainerProps = ReflectionSourcesPanelProps & { state: PanelState };

/** What the panel lists: the waiting quotes (the entries', then the reading) and the feed. */
function usePanelLists(
  items: ReflectionSourceItem[],
  readingQuotes: readonly ReadingQuoteItem[] | undefined,
) {
  const pending = useMemo(() => collectPending(items), [items]);
  const reading = useMemo(() => pendingReading(readingQuotes), [readingQuotes]);
  const feed = useMemo(() => [...items].sort(byTimestamp), [items]);
  return { pending, reading, feed };
}

/** The panel's inner content, shared by the sheet and the centred card. */
function SourcesContent({
  items,
  readingQuotes,
  window: reviewWindow,
  timeZone,
  anchorStatus,
  feedStatus = 'ready',
  onClose,
  onInsertQuotes,
  state,
}: ContainerProps): React.JSX.Element {
  const { pending, reading, feed } = usePanelLists(items, readingQuotes);
  const { includedIds, onInsert, onInsertReading, selection, onFoldSelected, folding } = state;

  // The heading is the panel's navigation, so it stands ABOVE the scroll: only
  // the quotes and the feed move, and the way out never scrolls away (#2883).
  return (
    <>
      <SourcesHeading window={reviewWindow} timeZone={timeZone} onClose={onClose} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="reflection-sources-scroll"
      >
        <PendingQuotesGroup
          pending={pending}
          reading={reading}
          includedIds={includedIds}
          selection={selection}
          canSelect={onInsertQuotes != null}
          onInsert={onInsert}
          onInsertReading={onInsertReading}
        />
        {feed.length === 0 ? (
          <EmptyFeed anchorStatus={anchorStatus} feedStatus={feedStatus} />
        ) : (
          <SourceFeed feed={feed} state={state.feed} timeZone={timeZone} />
        )}
      </ScrollView>
      {/* After the scroll, never inside it: like the heading, the one way to
          act on a selection stays in view however long the feed is (#2885). */}
      {selection.selecting ? (
        <QuoteFoldBar
          label={foldSelectedLabel(selection.selected.size)}
          count={selection.selected.size}
          disabled={folding}
          onPress={() => onFoldSelected(foldOrder(pending, reading))}
        />
      ) : null}
    </>
  );
}

/** Where the panel's frame sits in its Modal: rising from the foot, or centred. */
type SheetPlacement = 'bottom' | 'center';

/**
 * The panel's one container, a ``Modal`` at every width: a bottom sheet that
 * slides up, or a card that fades in centred over the desk (#3133). The Modal's
 * ``onRequestClose`` alone carries Escape (web) and the platform back button --
 * nothing else listens, so one request is one close. The backdrop is a sibling
 * BEFORE the frame, never its parent, so a press inside the frame (a row, the
 * selection field) cannot bubble up and close it. Crossing the breakpoint swaps
 * only this component's props, never its type, so the content does not remount.
 */
function SourcesSheet({
  placement,
  ...props
}: ContainerProps & { placement: SheetPlacement }): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const frame = SHEET_FRAMES[placement];
  return (
    <Modal
      visible
      transparent
      animationType={reducedMotion ? 'none' : frame.animation}
      onRequestClose={props.onClose}
      aria-label={SOURCES_DIALOG_LABEL}
      testID={frame.modalId}
    >
      <View style={frame.backdropStyle} testID="reflection-sources-scrim">
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={props.onClose}
          accessible={false}
          focusable={false}
          importantForAccessibility="no"
          testID="reflection-sources-backdrop"
        />
        <View style={frame.bodyStyle} testID={frame.bodyId}>
          <SourcesContent {...props} />
        </View>
      </View>
    </Modal>
  );
}

function ReflectionSourcesPanel(props: ReflectionSourcesPanelProps): React.JSX.Element {
  const state = usePanelState(props);
  const placement = useWindowDimensions().width < CENTRED_MODAL_BREAKPOINT ? 'bottom' : 'center';
  return <SourcesSheet {...props} state={state} placement={placement} />;
}

const styles = StyleSheet.create({
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.mystical.overlay,
  },
  sheet: {
    flexDirection: 'column',
    width: '100%',
    maxWidth: contentLayout.maxWidth,
    alignSelf: 'center',
    maxHeight: SHEET_MAX_HEIGHT,
    backgroundColor: surface.raised,
    borderTopLeftRadius: BORDER_RADIUS.lg,
    borderTopRightRadius: BORDER_RADIUS.lg,
    ...surfaceShadow.raised,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.mystical.overlay,
  },
  // No horizontal gutter: the card exists only from the breakpoint up, where
  // the reading measure is always narrower than the viewport.
  modalCard: {
    flexDirection: 'column',
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
    alignSelf: 'center',
    maxHeight: MODAL_MAX_HEIGHT,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    ...surfaceShadow.raised,
  },
  // Shrinks to the frame's bounded height (the sheet's or the card's cap) so
  // the feed scrolls beneath a heading that stays put.
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
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
  // A sub-section label inside the quotes band (DESIGN.md "Eyebrows are
  // eyebrows"): sentence case, the caption face in ink.muted, on the band's
  // left edge -- one beat of air above it, so it reads as a new group.
  subgroupLabel: {
    ...editorialType.caption,
    color: ink.muted,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
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
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
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

/** Each placement's motion, testIDs and frame styles; read once styles exist. */
const SHEET_FRAMES = {
  bottom: {
    animation: 'slide',
    modalId: 'reflection-sources-sheet',
    bodyId: 'reflection-sources-sheet-body',
    backdropStyle: styles.sheetBackdrop,
    bodyStyle: styles.sheet,
  },
  center: {
    animation: 'fade',
    modalId: 'reflection-sources-modal',
    bodyId: 'reflection-sources-modal-body',
    backdropStyle: styles.modalBackdrop,
    bodyStyle: styles.modalCard,
  },
} as const satisfies Record<
  SheetPlacement,
  {
    animation: 'slide' | 'fade';
    modalId: string;
    bodyId: string;
    backdropStyle: ViewStyle;
    bodyStyle: ViewStyle;
  }
>;

export default ReflectionSourcesPanel;
