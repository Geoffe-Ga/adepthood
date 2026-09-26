/**
 * ``PromotedQuotesScreen`` (#2865) — every quote the writer has promoted, found
 * on any day, not only inside the review composer that folds them in.
 *
 * Reached by a door the writer opens (the Journal drawer's "Promoted quotes"
 * row, which carries no count). Two sections, read separately so each header's
 * number is the server's total for that section rather than the length of a
 * loaded page: quotes still waiting for a review, then quotes already used in
 * one. Tapping a quote opens its page at the passage; a quote can be removed
 * (after a confirm, with a revert if the server refuses); and "Write a review"
 * opens the same early-review picker the shelf offers.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import { optimisticRemove } from './optimisticRemove';
import styles from './PromotedQuotes.styles';
import { QuoteRow } from './QuoteRow';
import { formatSourceDate } from './reflectionCopy';
import ReviewScopePicker from './ReviewScopePicker';
import type { ReviewEntryParams } from './reviewScopes';

import { promotions, type PromotedQuoteListItem, type PromotionStatusFilter } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/** How many quotes each section reads per page (the server's default page). */
export const PROMOTED_QUOTES_PAGE_SIZE = 50;

export const EMPTY_COPY =
  'Nothing promoted yet. While reading an entry, tap Promote a quote to carry a passage forward.';
const SCREEN_TITLE = 'Promoted quotes';
const SCREEN_EYEBROW = 'Carried forward';
const SCREEN_LEAD = 'Passages you lifted from your pages, waiting for a review or woven into one.';
const WRITE_REVIEW_LABEL = 'Write a review';
const LOAD_ERROR_COPY = 'We could not reach your promoted quotes.';
const RETRY_LABEL = 'Try again';
const LOAD_MORE_LABEL = 'Older quotes';
const REMOVE_LABEL = 'Remove';
const KEEP_LABEL = 'Keep';
const CONFIRM_PROMPT = 'Remove this quote?';
const USED_FALLBACK = 'Used in a review';
const STALE_NOTE = 'Passage since edited';
const CAPTION_SEPARATOR = ' · ';

type SectionStatus = Extract<PromotionStatusFilter, 'pending' | 'included'>;
type ScreenNavigation = NativeStackNavigationProp<RootStackParamList>;

/** Each section's header, by status, carrying the server's total. */
const SECTION_HEADINGS: Record<SectionStatus, (_total: number) => string> = {
  pending: (total) => `Waiting for your next review (${total})`,
  included: (total) => `Used in a review (${total})`,
};
/** What an empty section says, when the other section has quotes. */
const SECTION_EMPTY: Record<SectionStatus, string> = {
  pending: 'Nothing is waiting right now.',
  included: 'None has gone into a review yet.',
};

/** ``created_at`` desc, then ``id`` desc -- the server's own order. */
function newerFirst(a: PromotedQuoteListItem, b: PromotedQuoteListItem): number {
  return b.created_at.localeCompare(a.created_at) || b.id - a.id;
}

/**
 * Put a quote back where the server's order places it, for the revert of a
 * failed remove. A quote already present is left alone, never duplicated.
 */
export function reinsertByCreatedDesc(
  items: PromotedQuoteListItem[],
  quote: PromotedQuoteListItem,
): PromotedQuoteListItem[] {
  if (items.some((row) => row.id === quote.id)) return items;
  const at = items.findIndex((row) => newerFirst(quote, row) < 0);
  return at === -1 ? [...items, quote] : [...items.slice(0, at), quote, ...items.slice(at)];
}

/** The source a quote came from: its title, else the day it was written. */
function sourceLabel(quote: PromotedQuoteListItem): string {
  return quote.source_title?.trim() || formatSourceDate(quote.source_timestamp);
}

/** Where a used quote went; a review since deleted is named only as "a review". */
function usedLabel(quote: PromotedQuoteListItem): string | null {
  if (quote.included_in_entry_id == null) return null;
  return quote.included_in_title ? `In ${quote.included_in_title}` : USED_FALLBACK;
}

/** The line beneath a quote: source, then where it was used, then a stale note. */
export function quoteCaption(quote: PromotedQuoteListItem): string {
  const parts = [sourceLabel(quote), usedLabel(quote), quote.stale ? STALE_NOTE : null];
  return parts.filter((part): part is string => part != null).join(CAPTION_SEPARATOR);
}

/** The row's accessible name: the quote and its source, and its review if used. */
export function quoteA11yLabel(quote: PromotedQuoteListItem): string {
  const base = `“${quote.anchor_text}” from ${sourceLabel(quote)}`;
  if (quote.included_in_entry_id == null) return base;
  return `${base}, used in ${quote.included_in_title ?? 'a review'}`;
}

interface SectionState {
  items: PromotedQuoteListItem[];
  total: number;
  loading: boolean;
  /** Null until a read fails; holds the sentence the reader is shown. */
  error: string | null;
  hasMore: boolean;
  /** False until the first read settles, so an empty section is never shown early. */
  settled: boolean;
}

const INITIAL_SECTION: SectionState = {
  items: [],
  total: 0,
  loading: true,
  error: null,
  hasMore: false,
  settled: false,
};

export interface QuoteSection extends SectionState {
  status: SectionStatus;
  loadMore: () => void;
  /** Re-read from the top, abandoning any read in flight. */
  reload: () => void;
  setItems: React.Dispatch<React.SetStateAction<PromotedQuoteListItem[]>>;
  /** Move the section total by ``delta`` (an optimistic remove, or its revert). */
  adjustTotal: (_delta: number) => void;
}

/** Updater landing one page: the first replaces the section, a later one appends. */
function pageLanded(
  page: { items: PromotedQuoteListItem[]; total: number; has_more: boolean },
  offset: number,
) {
  return (previous: SectionState): SectionState => ({
    items: offset === 0 ? page.items : [...previous.items, ...page.items],
    total: page.total,
    loading: false,
    error: null,
    hasMore: page.has_more,
    settled: true,
  });
}

/** Updater recording a failed read without discarding what was already read. */
function readFailed(error: string) {
  return (previous: SectionState): SectionState => ({
    ...previous,
    loading: false,
    error,
    settled: true,
  });
}

/** Read one section's pages; a generation counter drops a page a reload overtook. */
function useSectionReader(status: SectionStatus) {
  const [state, setState] = useState<SectionState>(INITIAL_SECTION);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const read = useCallback(
    (offset: number) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const mine = generation.current;
      setState((previous) => ({ ...previous, loading: true, error: null }));
      promotions
        .listAll({ status, limit: PROMOTED_QUOTES_PAGE_SIZE, offset })
        .then((page) => {
          if (mine === generation.current) setState(pageLanded(page, offset));
        })
        .catch((failure: unknown) => {
          if (mine === generation.current) setState(readFailed(formatApiError(failure)));
        })
        .finally(() => {
          if (mine === generation.current) inFlight.current = false;
        });
    },
    [status],
  );

  const reload = useCallback(() => {
    generation.current += 1;
    inFlight.current = false;
    read(0);
  }, [read]);

  return { state, setState, read, reload };
}

/** One section's pages, plus the setters an optimistic remove needs. */
function useQuoteSection(status: SectionStatus): QuoteSection {
  const { state, setState, read, reload } = useSectionReader(status);

  useEffect(() => {
    read(0);
  }, [read]);

  const { hasMore, loading, items } = state;
  const loadMore = useCallback(() => {
    if (hasMore && !loading) read(items.length);
  }, [hasMore, loading, items.length, read]);
  const setItems = useCallback<QuoteSection['setItems']>(
    (next) =>
      setState((previous) => ({
        ...previous,
        items: typeof next === 'function' ? next(previous.items) : next,
      })),
    [setState],
  );
  const adjustTotal = useCallback(
    (delta: number) => setState((previous) => ({ ...previous, total: previous.total + delta })),
    [setState],
  );

  return { ...state, status, loadMore, reload, setItems, adjustTotal };
}

/** Re-read both sections whenever the screen regains focus -- but not on the first. */
function useReloadOnRefocus(navigation: ScreenNavigation, reload: () => void): void {
  const focusedOnce = useRef(false);
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        if (focusedOnce.current) reload();
        focusedOnce.current = true;
      }),
    [navigation, reload],
  );
}

/** The inline "Remove this quote?" step: web-safe, unlike a native alert. */
function RemoveConfirm({
  id,
  onConfirm,
  onKeep,
}: {
  id: number;
  onConfirm: () => void;
  onKeep: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.confirm} testID={`promoted-quote-${id}-confirm`}>
      <Text style={styles.confirmPrompt}>{CONFIRM_PROMPT}</Text>
      <Button
        variant="secondary"
        label={REMOVE_LABEL}
        accessibilityLabel="Remove this quote"
        testID={`promoted-quote-${id}-confirm-remove`}
        onPress={onConfirm}
      />
      <Button
        variant="tertiary"
        label={KEEP_LABEL}
        accessibilityLabel="Keep this quote"
        testID={`promoted-quote-${id}-confirm-keep`}
        onPress={onKeep}
      />
    </View>
  );
}

interface RowActions {
  confirmingId: number | null;
  onOpen: (_quote: PromotedQuoteListItem) => void;
  onAskRemove: (_id: number) => void;
  onConfirmRemove: (_section: QuoteSection, _id: number) => void;
  onKeep: () => void;
}

/** One quote: the shared row look, a Remove link beside it, and its confirm. */
function PromotedQuoteRow({
  quote,
  section,
  actions,
}: {
  quote: PromotedQuoteListItem;
  section: QuoteSection;
  actions: RowActions;
}): React.JSX.Element {
  const removeLink = (
    <TouchableOpacity
      style={styles.removeLink}
      accessibilityRole="button"
      accessibilityLabel={`Remove the quote “${quote.anchor_text}”`}
      testID={`promoted-quote-${quote.id}-remove`}
      onPress={() => actions.onAskRemove(quote.id)}
    >
      <Text style={styles.actionText}>{REMOVE_LABEL}</Text>
    </TouchableOpacity>
  );
  return (
    <>
      <QuoteRow
        text={quote.anchor_text}
        caption={quoteCaption(quote)}
        dimmed={section.status === 'included'}
        onPress={() => actions.onOpen(quote)}
        accessibilityLabel={quoteA11yLabel(quote)}
        testID={`promoted-quote-${quote.id}`}
        trailing={removeLink}
      />
      {actions.confirmingId === quote.id ? (
        <RemoveConfirm
          id={quote.id}
          onConfirm={() => actions.onConfirmRemove(section, quote.id)}
          onKeep={actions.onKeep}
        />
      ) : null}
    </>
  );
}

/** A section's failure line with its own retry, beneath whatever it did load. */
function SectionError({ section }: { section: QuoteSection }): React.JSX.Element {
  return (
    <View style={styles.errorBlock} testID={`promoted-quotes-${section.status}-error`}>
      <Text style={styles.errorText} accessibilityRole="alert">
        {section.error}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={section.reload}
        style={styles.actionRow}
      >
        <Text style={styles.actionText}>{RETRY_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** What follows a section's rows: its failure, a page of older quotes, or nothing. */
function SectionFooter({ section }: { section: QuoteSection }): React.JSX.Element | null {
  if (section.error !== null) return <SectionError section={section} />;
  if (!section.hasMore) return null;
  return (
    <TouchableOpacity
      testID={`promoted-quotes-${section.status}-load-more`}
      accessibilityRole="button"
      onPress={section.loadMore}
      style={styles.actionRow}
    >
      <Text style={styles.actionText}>{LOAD_MORE_LABEL}</Text>
    </TouchableOpacity>
  );
}

/** One section: its header (with the server total), its rows, and its footer. */
function QuoteSectionView({
  section,
  actions,
}: {
  section: QuoteSection;
  actions: RowActions;
}): React.JSX.Element {
  return (
    <View style={styles.section} testID={`promoted-quotes-${section.status}`}>
      <Text accessibilityRole="header" style={styles.sectionHeading}>
        {SECTION_HEADINGS[section.status](section.total)}
      </Text>
      {section.settled && section.items.length === 0 && section.error === null ? (
        <Text style={styles.sectionNote}>{SECTION_EMPTY[section.status]}</Text>
      ) : null}
      {section.items.map((quote) => (
        <PromotedQuoteRow key={quote.id} quote={quote} section={section} actions={actions} />
      ))}
      <SectionFooter section={section} />
    </View>
  );
}

/** The whole-screen failure: nothing loaded anywhere, so say so and offer a retry. */
function LoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <View style={styles.errorBlock} testID="promoted-quotes-error">
      <Text style={styles.errorText} accessibilityRole="alert">
        {LOAD_ERROR_COPY}
      </Text>
      <TouchableOpacity
        testID="promoted-quotes-retry"
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.actionRow}
      >
        <Text style={styles.actionText}>{RETRY_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

type BodyView = 'loading' | 'error' | 'empty' | 'sections';

/** Which of the four states the two sections add up to. */
function bodyView(sections: readonly QuoteSection[]): BodyView {
  const empty = sections.every((s) => s.items.length === 0);
  if (!empty) return 'sections';
  if (sections.some((s) => !s.settled)) return 'loading';
  if (sections.every((s) => s.error !== null)) return 'error';
  return sections.every((s) => s.error === null && s.total === 0) ? 'empty' : 'sections';
}

/** The body beneath the header: spinner, failure, the empty state, or the sections. */
function ScreenBody({
  sections,
  actions,
  onRetryAll,
}: {
  sections: readonly QuoteSection[];
  actions: RowActions;
  onRetryAll: () => void;
}): React.JSX.Element {
  const view = bodyView(sections);
  if (view === 'loading') {
    return (
      <ActivityIndicator
        testID="promoted-quotes-loading"
        color={accent.primary}
        style={styles.loading}
      />
    );
  }
  if (view === 'error') return <LoadError onRetry={onRetryAll} />;
  if (view === 'empty') {
    return (
      <View style={styles.emptyBlock} testID="promoted-quotes-empty">
        <Text style={styles.emptyBody}>{EMPTY_COPY}</Text>
      </View>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <QuoteSectionView key={section.status} section={section} actions={actions} />
      ))}
    </>
  );
}

/** Row presses, the inline confirm, and the optimistic remove with its revert. */
function useRowActions(navigation: ScreenNavigation): RowActions & { removeError: string | null } {
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const pendingIds = useRef(new Set<number>()).current;

  const onOpen = useCallback(
    (quote: PromotedQuoteListItem) =>
      navigation.navigate('JournalEntry', {
        entryId: quote.source_entry_id,
        highlightSpan: { start: quote.anchor_start, end: quote.anchor_end },
      }),
    [navigation],
  );
  const onKeep = useCallback(() => setConfirmingId(null), []);
  const onConfirmRemove = useCallback(
    (section: QuoteSection, id: number) => {
      setConfirmingId(null);
      void optimisticRemove(id, {
        pendingIds,
        current: section.items,
        setItems: section.setItems,
        removeRemote: (quoteId) => promotions.remove(quoteId),
        reinsert: reinsertByCreatedDesc,
        beforeStart: () => {
          setRemoveError(null);
          section.adjustTotal(-1);
        },
        onError: (message) => {
          section.adjustTotal(1);
          setRemoveError(message);
        },
      });
    },
    [pendingIds],
  );

  return {
    confirmingId,
    onOpen,
    onAskRemove: setConfirmingId,
    onConfirmRemove,
    onKeep,
    removeError,
  };
}

const PromotedQuotesScreen = (): React.JSX.Element => {
  const navigation = useNavigation<ScreenNavigation>();
  const pending = useQuoteSection('pending');
  const included = useQuoteSection('included');
  const actions = useRowActions(navigation);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { reload: reloadPending } = pending;
  const { reload: reloadIncluded } = included;
  const reloadAll = useCallback(() => {
    reloadPending();
    reloadIncluded();
  }, [reloadPending, reloadIncluded]);
  useReloadOnRefocus(navigation, reloadAll);
  const chooseReview = useCallback(
    (params: ReviewEntryParams) => {
      setPickerOpen(false);
      navigation.navigate('JournalEntry', params);
    },
    [navigation],
  );

  return (
    <ScreenScaffold scroll testID="promoted-quotes-screen">
      <ScreenHeader eyebrow={SCREEN_EYEBROW} title={SCREEN_TITLE} lead={SCREEN_LEAD} />
      <Button
        variant="secondary"
        label={WRITE_REVIEW_LABEL}
        accessibilityLabel={WRITE_REVIEW_LABEL}
        testID="promoted-quotes-write-review"
        onPress={() => setPickerOpen((open) => !open)}
        style={styles.writeReview}
      />
      <ReviewScopePicker enabled={pickerOpen} onChoose={chooseReview} />
      {actions.removeError !== null ? (
        <Text
          style={styles.errorText}
          accessibilityRole="alert"
          testID="promoted-quotes-remove-error"
        >
          {actions.removeError}
        </Text>
      ) : null}
      <ScreenBody sections={[pending, included]} actions={actions} onRetryAll={reloadAll} />
    </ScreenScaffold>
  );
};

export default PromotedQuotesScreen;
