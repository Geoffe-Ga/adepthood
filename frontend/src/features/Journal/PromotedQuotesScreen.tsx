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
 *
 * "Select quotes" turns the waiting quotes into checkboxes, and one action
 * fixed beneath the scroll folds the checked ones into a review (#2885) -- see
 * ``PromotedQuotesFold`` for its two arms.
 */
import { useNavigation } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import styles from './PromotedQuotes.styles';
import { ScreenFoldFooter, useScreenFold } from './PromotedQuotesFold';
import { SELECT_ALL_LOADED_NOTE } from './quoteFoldCopy';
import { QuoteRow } from './QuoteRow';
import { SelectionHeader } from './QuoteSelectionControls';
import { quoteAttribution } from './reflectionCopy';
import ReviewScopePicker from './ReviewScopePicker';
import type { ReviewEntryParams } from './reviewScopes';
import {
  PROMOTED_QUOTES_PAGE_SIZE,
  reinsertByCreatedDesc,
  usePromotedQuoteSection,
  type QuoteSection,
  type SectionStatus,
} from './usePromotedQuoteSection';
import { useQuoteSelection, type QuoteSelection } from './useQuoteSelection';

import type { PromotedQuoteListItem } from '@/api';
import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

export { PROMOTED_QUOTES_PAGE_SIZE, reinsertByCreatedDesc };

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

type ScreenNavigation = NativeStackNavigationProp<RootStackParamList>;

/**
 * Each section's header, by status, carrying the server's total.
 *
 * "Not yet in a review", not "waiting for your next review": a pending quote
 * surfaces among the sources of a review covering the week its entry was
 * written (``GET /reflections/sources``), not in whichever review comes next.
 */
const SECTION_HEADINGS: Record<SectionStatus, (_total: number) => string> = {
  pending: (total) => `Not yet in a review (${total})`,
  included: (total) => `Used in a review (${total})`,
};
/** What an empty section says, when the other section has quotes. */
const SECTION_EMPTY: Record<SectionStatus, string> = {
  pending: 'Nothing is waiting right now.',
  included: 'None has gone into a review yet.',
};

/**
 * The source a quote came from: its title, else the day it was written. The
 * SAME composer as the attribution a fold writes into a review (#2885), so the
 * caption names the source exactly as the folded block will.
 */
function sourceLabel(quote: PromotedQuoteListItem): string {
  return quoteAttribution({ title: quote.source_title, timestamp: quote.source_timestamp });
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
  const from = `“${quote.anchor_text}” from ${sourceLabel(quote)}`;
  const used =
    quote.included_in_entry_id == null
      ? from
      : `${from}, used in ${quote.included_in_title ?? 'a review'}`;
  // Label-in-name: the caption's visible stale note is part of the row's name.
  return quote.stale ? `${used}. ${STALE_NOTE}` : used;
}

/**
 * Re-read both sections whenever the screen regains focus -- but not on the
 * first -- and count those refocuses, so the review picker re-reads too.
 */
function useReloadOnRefocus(navigation: ScreenNavigation, reload: () => void): number {
  const focusedOnce = useRef(false);
  const [refocusCount, setRefocusCount] = useState(0);
  const onFocus = useCallback(() => {
    if (focusedOnce.current) {
      reload();
      setRefocusCount((count) => count + 1);
    }
    focusedOnce.current = true;
  }, [reload]);
  useEffect(() => navigation.addListener('focus', onFocus), [navigation, onFocus]);
  return refocusCount;
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
  /** The checked quotes; a pending row is a checkbox while it is selecting. */
  selection: QuoteSelection;
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
  const { selection } = actions;
  const checkable = selection.selecting && section.status === 'pending';
  return (
    <>
      <QuoteRow
        text={quote.anchor_text}
        caption={quoteCaption(quote)}
        dimmed={section.status === 'included'}
        checked={checkable ? selection.selected.has(quote.id) : undefined}
        onPress={() => (checkable ? selection.toggle(quote.id) : actions.onOpen(quote))}
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
      <TouchableOpacity accessibilityRole="button" onPress={section.retry} style={styles.actionRow}>
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
      // Paging waits for any remove in flight: until it settles, the list is a
      // row short of the server's and its length is not the next page's offset.
      accessibilityState={{ disabled: section.removing > 0 }}
      disabled={section.removing > 0}
      onPress={section.loadMore}
      style={styles.actionRow}
    >
      <Text style={styles.actionText}>{LOAD_MORE_LABEL}</Text>
    </TouchableOpacity>
  );
}

/**
 * Select / Select all / Clear all over the pending section. Select all takes
 * the LOADED rows only -- the header's total can be larger -- and while older
 * quotes remain unloaded a visible note says so (a hint alone would be dropped
 * on the web).
 */
function PendingSelectionHeader({
  section,
  selection,
}: {
  section: QuoteSection;
  selection: QuoteSelection;
}): React.JSX.Element {
  return (
    <SelectionHeader
      selecting={selection.selecting}
      onToggleMode={selection.toggleMode}
      onSelectAll={() => selection.selectAll(section.items.map((quote) => quote.id))}
      onClear={selection.clear}
      selectAllNote={section.hasMore ? SELECT_ALL_LOADED_NOTE : undefined}
      testIDPrefix="promoted-quotes-pending"
    />
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
      {section.status === 'pending' && section.items.length > 0 ? (
        <PendingSelectionHeader section={section} selection={actions.selection} />
      ) : null}
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
function useRowActions(
  navigation: ScreenNavigation,
  selection: QuoteSelection,
): RowActions & { removeError: string | null } {
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const onOpen = useCallback(
    (quote: PromotedQuoteListItem) =>
      navigation.navigate('JournalEntry', {
        entryId: quote.source_entry_id,
        highlightSpan: { start: quote.anchor_start, end: quote.anchor_end },
      }),
    [navigation],
  );
  const onKeep = useCallback(() => setConfirmingId(null), []);
  const onConfirmRemove = useCallback((section: QuoteSection, id: number) => {
    setConfirmingId(null);
    void section.remove(id, { onStart: () => setRemoveError(null), onError: setRemoveError });
  }, []);

  return {
    selection,
    confirmingId,
    onOpen,
    onAskRemove: setConfirmingId,
    onConfirmRemove,
    onKeep,
    removeError,
  };
}

/** Reload both sections together, and on every refocus after the first. */
function useBothSections(
  navigation: ScreenNavigation,
  pending: QuoteSection,
  included: QuoteSection,
): { reloadAll: () => void; refocusCount: number } {
  const { reload: reloadPending } = pending;
  const { reload: reloadIncluded } = included;
  const reloadAll = useCallback(() => {
    reloadPending();
    reloadIncluded();
  }, [reloadPending, reloadIncluded]);
  const refocusCount = useReloadOnRefocus(navigation, reloadAll);
  return { reloadAll, refocusCount };
}

/** A refused remove's message, once it has one. */
function RemoveError({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <Text style={styles.errorText} accessibilityRole="alert" testID="promoted-quotes-remove-error">
      {message}
    </Text>
  );
}

type PromotedQuotesScreenProps = Partial<
  NativeStackScreenProps<RootStackParamList, 'PromotedQuotes'>
>;

const PromotedQuotesScreen = ({ route }: PromotedQuotesScreenProps = {}): React.JSX.Element => {
  const navigation = useNavigation<ScreenNavigation>();
  const pending = usePromotedQuoteSection('pending');
  const included = usePromotedQuoteSection('included');
  const selection = useQuoteSelection();
  const actions = useRowActions(navigation, selection);
  const fold = useScreenFold(route?.params?.injectInto, pending, selection);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { reloadAll, refocusCount } = useBothSections(navigation, pending, included);
  const chooseReview = useCallback(
    (params: ReviewEntryParams) => {
      setPickerOpen(false);
      navigation.navigate('JournalEntry', params);
    },
    [navigation],
  );

  return (
    <ScreenScaffold
      scroll
      testID="promoted-quotes-screen"
      footer={
        selection.selecting ? (
          <ScreenFoldFooter fold={fold} count={selection.selected.size} refreshKey={refocusCount} />
        ) : null
      }
    >
      <ScreenHeader eyebrow={SCREEN_EYEBROW} title={SCREEN_TITLE} lead={SCREEN_LEAD} />
      <Button
        variant="secondary"
        label={WRITE_REVIEW_LABEL}
        accessibilityLabel={WRITE_REVIEW_LABEL}
        testID="promoted-quotes-write-review"
        onPress={() => setPickerOpen((open) => !open)}
        style={styles.writeReview}
      />
      <ReviewScopePicker enabled={pickerOpen} refreshKey={refocusCount} onChoose={chooseReview} />
      <RemoveError message={actions.removeError} />
      <ScreenBody sections={[pending, included]} actions={actions} onRetryAll={reloadAll} />
    </ScreenScaffold>
  );
};

export default PromotedQuotesScreen;
