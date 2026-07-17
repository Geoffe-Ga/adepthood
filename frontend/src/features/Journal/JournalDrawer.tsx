/**
 * The Journal header-drawer body: a New-entry row pinned on top, then the user's
 * past entries grouped by recency (This week / This month / Earlier, newest
 * first, empty bands dropped), a tappable "Load older entries" row, and a
 * spinner / error+retry while the first page loads.
 *
 * Entries are fetched lazily on the drawer's first open via the co-located
 * ``useJournalDrawerEntries`` hook, which lives above the ``ScreenDrawer`` panel
 * so its cache survives close/reopen (mirrors ``useCourseDrawerContent``).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { groupByRecency, formatDate, type ShelfSection } from './recency';
import { usePagedJournal } from './usePagedJournal';

import type { JournalMessage } from '@/api';
import {
  DrawerItem,
  DrawerNavSection,
  DrawerSearch,
  rankMatches,
  ScreenDrawer,
  type ScreenDrawerState,
} from '@/components/drawer';
import { accent, ink, radius, SPACING, surface, touchTarget, type } from '@/design/tokens';

/** Row that starts a fresh, blank entry. */
const NEW_ENTRY_LABEL = 'New entry';
/** Row that fetches and appends the next page of older entries. */
const LOAD_MORE_LABEL = 'Load older entries';
/** Fallback label for an entry saved without a title. */
const UNTITLED_LABEL = 'Untitled';
/** Placeholder for the drawer's fuzzy entry-search field. */
const SEARCH_PLACEHOLDER = 'Search entries...';
/** Accessibility label for the drawer's fuzzy entry-search field. */
const SEARCH_ACCESSIBILITY_LABEL = 'Search entries';
/** Confirm-row copy that invites widening the search into entry bodies. */
const DEEP_SEARCH_LABEL = 'Search inside entries? This loads your older entries.';
/** Copy shown when the entry fetch failed, above the retry row. */
const ERROR_LABEL = 'We could not load your entries.';
/** Retry affordance shown alongside the error copy. */
const RETRY_LABEL = 'Tap to retry';

/**
 * Fetch the drawer's entries lazily on its first open and cache them across
 * close/reopen. The first fetch pulls page 0; ``loadMore`` appends the next page
 * (offset = current count) and is guarded so a concurrent or duplicate press is
 * a no-op; ``retry`` refetches page 0 after a failure.
 *
 * The hook must be mounted above the ``ScreenDrawer`` panel (which unmounts when
 * closed) so its cache outlives a close/reopen — the first open latches the fetch
 * via ``hasOpened`` and never refires it.
 */
export function useJournalDrawerEntries(isOpen: boolean): {
  items: JournalMessage[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
  confirmBodySearch: () => void;
} {
  const { items, hasMore, loading, error, load, loadAll } = usePagedJournal();
  const hasOpened = useRef(false);

  useEffect(() => {
    if (!isOpen || hasOpened.current) return;
    hasOpened.current = true;
    void load(undefined, 0);
  }, [isOpen, load]);

  const loadMore = useCallback(() => {
    // Ignore a press while a page is already in flight or none remain.
    if (hasMore && !loading) void load(undefined, items.length);
  }, [hasMore, loading, load, items.length]);

  const retry = useCallback(() => {
    void load(undefined, 0);
  }, [load]);

  const confirmBodySearch = useCallback(() => {
    // Pull in every remaining older page so body matching sees the full corpus;
    // guarded like loadMore so a fetch in flight or an exhausted list is a no-op.
    if (hasMore && !loading) void loadAll(items.length);
  }, [hasMore, loading, loadAll, items.length]);

  return { items, loading, error: error !== null, hasMore, loadMore, retry, confirmBodySearch };
}

/** The entry's trimmed title, or the untitled fallback when it has none. */
function entryLabel(entry: JournalMessage): string {
  const title = entry.title;
  if (typeof title === 'string' && title.trim().length > 0) return title;
  return UNTITLED_LABEL;
}

/** Full-panel spinner shown before the first page of entries resolves. */
function DrawerLoading(): React.JSX.Element {
  return (
    <ActivityIndicator
      testID="journal-drawer-loading"
      size="small"
      color={accent.primary}
      style={styles.loading}
    />
  );
}

/** Error copy plus a retry row shown when the entry fetch failed. */
function DrawerError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { width } = useWindowDimensions();
  return (
    <View testID="journal-drawer-error" style={styles.errorBlock}>
      <Text style={[type(width).body, styles.errorText]}>{ERROR_LABEL}</Text>
      <DrawerItem testID="journal-drawer-retry" label={RETRY_LABEL} onPress={onRetry} />
    </View>
  );
}

interface EntryRowProps {
  entry: JournalMessage;
  selected: boolean;
  onPress: (_id: number) => void;
}

/** One entry row: title (or "Untitled") + its saved date, selectable + tappable. */
const EntryRow = ({ entry, selected, onPress }: EntryRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const label = entryLabel(entry);
  const dateText = formatDate(entry.timestamp);
  // Drop the separator when the date is unparseable so the label never trails a
  // bare comma.
  const a11yLabel = dateText ? `${label}, ${dateText}` : label;
  return (
    <TouchableOpacity
      testID={`journal-drawer-entry-${entry.id}`}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected }}
      onPress={() => onPress(entry.id)}
      style={[styles.entryRow, selected && styles.entryRowSelected]}
    >
      <Text style={[type(width).body, styles.entryLabel]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[type(width).caption, styles.entryDate]}>{dateText}</Text>
    </TouchableOpacity>
  );
};

interface RecencySectionProps {
  section: ShelfSection;
  currentEntryId?: number | null;
  onRowPress: (_id: number) => void;
}

/** A recency band heading above its newest-first entry rows. */
const RecencySection = ({
  section,
  currentEntryId,
  onRowPress,
}: RecencySectionProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  return (
    <View style={styles.section}>
      <Text style={[type(width).label, styles.sectionHeading]} accessibilityRole="header">
        {section.title}
      </Text>
      {section.data.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          selected={entry.id === currentEntryId}
          onPress={onRowPress}
        />
      ))}
    </View>
  );
};

interface DrawerBodyProps {
  sections: ShelfSection[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  currentEntryId?: number | null;
  onRowPress: (_id: number) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

/** The rows below the pinned New-entry row: spinner, error, or the grouped list. */
function DrawerBody({
  sections,
  loading,
  error,
  hasMore,
  currentEntryId,
  onRowPress,
  onLoadMore,
  onRetry,
}: DrawerBodyProps): React.JSX.Element {
  if (error) return <DrawerError onRetry={onRetry} />;
  // Only the first load blanks the list; a "load more" keeps the entries visible.
  if (loading && sections.length === 0) return <DrawerLoading />;
  return (
    <View>
      {sections.map((section) => (
        <RecencySection
          key={section.title}
          section={section}
          currentEntryId={currentEntryId}
          onRowPress={onRowPress}
        />
      ))}
      {hasMore ? (
        <DrawerItem
          testID="journal-drawer-load-more"
          label={LOAD_MORE_LABEL}
          onPress={onLoadMore}
        />
      ) : null}
    </View>
  );
}

interface SearchResultsProps {
  matches: JournalMessage[];
  currentEntryId?: number | null;
  onRowPress: (_id: number) => void;
}

/** Flat, ranked matches for an active query: no recency headings, no load-more. */
function SearchResults({
  matches,
  currentEntryId,
  onRowPress,
}: SearchResultsProps): React.JSX.Element {
  return (
    <View>
      {matches.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          selected={entry.id === currentEntryId}
          onPress={onRowPress}
        />
      ))}
    </View>
  );
}

interface DrawerSearchFieldProps {
  /** Match count for the active query, or undefined to hide the caption. */
  resultCount?: number;
  /** True once the deep body search is confirmed; hides the confirm row. */
  bodySearchActive: boolean;
  /** Receives the debounced query (or '' on clear). */
  onQueryChange: (_query: string) => void;
  /** Confirm widening the search into entry bodies. */
  onConfirmDeepSearch: () => void;
}

/**
 * The drawer's search field. The deep-search confirm row is offered only until
 * body search is active; because ``DrawerSearchProps`` is an exclusive union, we
 * branch the element rather than widen the props to keep the deep pair paired.
 */
function DrawerSearchField({
  resultCount,
  bodySearchActive,
  onQueryChange,
  onConfirmDeepSearch,
}: DrawerSearchFieldProps): React.JSX.Element {
  const shared = {
    testID: 'journal-drawer-search',
    placeholder: SEARCH_PLACEHOLDER,
    accessibilityLabel: SEARCH_ACCESSIBILITY_LABEL,
    resultCount,
    onQueryChange,
  };
  if (bodySearchActive) return <DrawerSearch {...shared} />;
  return (
    <DrawerSearch
      {...shared}
      onConfirmDeepSearch={onConfirmDeepSearch}
      deepSearchLabel={DEEP_SEARCH_LABEL}
    />
  );
}

export interface JournalDrawerProps {
  /** The entries to group and render (newest-first, per the API order). */
  items: JournalMessage[];
  /** Epoch ms used to bucket entries into recency bands. */
  now: number;
  /** True until the first page resolves; drives the spinner. */
  loading: boolean;
  /** True when the entry fetch failed; drives the error + retry state. */
  error: boolean;
  /** Whether an older page remains to load. */
  hasMore: boolean;
  /** The entry currently shown on-screen, highlighted in the list (or none). */
  currentEntryId?: number | null;
  /** Open the tapped entry. */
  onRowPress: (_id: number) => void;
  /** Start a fresh, blank entry. */
  onNewEntry: () => void;
  /** Fetch and append the next older page. */
  onLoadMore: () => void;
  /** Refetch the first page after a failure. */
  onRetry: () => void;
  /**
   * Confirm the deep body search: the host pulls in every remaining older page
   * so the subsequent match runs against titles and message bodies alike.
   */
  onConfirmBodySearch: () => void;
}

interface DrawerSearchState {
  bodySearchActive: boolean;
  isSearching: boolean;
  matches: JournalMessage[];
  handleQueryChange: (_next: string) => void;
  handleConfirmDeepSearch: () => void;
}

/**
 * Own the drawer's search query and body-search gate, and derive the ranked
 * matches. A cleared query drops back to title-only until body search is
 * re-confirmed; body search additionally ranks against each entry's message.
 */
function useDrawerSearch(
  items: JournalMessage[],
  onConfirmBodySearch: () => void,
): DrawerSearchState {
  const [query, setQuery] = useState('');
  const [bodySearchActive, setBodySearchActive] = useState(false);

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
    if (next.length === 0) setBodySearchActive(false);
  }, []);

  const handleConfirmDeepSearch = useCallback(() => {
    setBodySearchActive(true);
    onConfirmBodySearch();
  }, [onConfirmBodySearch]);

  const isSearching = query.length > 0;
  const getText = (entry: JournalMessage): string =>
    bodySearchActive ? `${entryLabel(entry)} ${entry.message}` : entryLabel(entry);
  const matches = isSearching ? rankMatches(query, items, getText) : items;

  return { bodySearchActive, isSearching, matches, handleQueryChange, handleConfirmDeepSearch };
}

/** The Journal header drawer's contents: New entry, a search field, then the list. */
export default function JournalDrawer({
  items,
  now,
  loading,
  error,
  hasMore,
  currentEntryId,
  onRowPress,
  onNewEntry,
  onLoadMore,
  onRetry,
  onConfirmBodySearch,
}: JournalDrawerProps): React.JSX.Element {
  const { bodySearchActive, isSearching, matches, handleQueryChange, handleConfirmDeepSearch } =
    useDrawerSearch(items, onConfirmBodySearch);

  return (
    <View testID="journal-drawer">
      <DrawerItem testID="journal-drawer-new-entry" label={NEW_ENTRY_LABEL} onPress={onNewEntry} />
      <DrawerSearchField
        resultCount={isSearching ? matches.length : undefined}
        bodySearchActive={bodySearchActive}
        onQueryChange={handleQueryChange}
        onConfirmDeepSearch={handleConfirmDeepSearch}
      />
      {isSearching ? (
        <SearchResults matches={matches} currentEntryId={currentEntryId} onRowPress={onRowPress} />
      ) : (
        <DrawerBody
          sections={groupByRecency(items, now)}
          loading={loading}
          error={error}
          hasMore={hasMore}
          currentEntryId={currentEntryId}
          onRowPress={onRowPress}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
        />
      )}
    </View>
  );
}

export interface JournalScreenDrawerProps {
  /** The screen's drawer open/close state (from ``useScreenDrawer``). */
  drawer: ScreenDrawerState;
  /** The entry currently shown on-screen, highlighted in the list (or none). */
  currentEntryId?: number | null;
  /** Open the tapped entry, then close the drawer. */
  onSelectEntry: (_id: number) => void;
  /** Start a fresh entry, then close the drawer. */
  onNewEntry: () => void;
}

/** The Journal header drawer wired to its lazy, cache-above-the-panel entry fetch. */
export function JournalScreenDrawer({
  drawer,
  currentEntryId,
  onSelectEntry,
  onNewEntry,
}: JournalScreenDrawerProps): React.JSX.Element {
  const { items, loading, error, hasMore, loadMore, retry, confirmBodySearch } =
    useJournalDrawerEntries(drawer.isOpen);
  return (
    <ScreenDrawer
      visible={drawer.isOpen}
      onClose={drawer.close}
      screenName="Journal"
      title="Journal"
    >
      <DrawerNavSection currentScreen="Journal" onNavigate={drawer.close} />
      <JournalDrawer
        items={items}
        now={Date.now()}
        loading={loading}
        error={error}
        hasMore={hasMore}
        currentEntryId={currentEntryId}
        onRowPress={onSelectEntry}
        onNewEntry={onNewEntry}
        onLoadMore={loadMore}
        onRetry={retry}
        onConfirmBodySearch={confirmBodySearch}
      />
    </ScreenDrawer>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignSelf: 'flex-start',
    paddingVertical: SPACING.sm,
  },
  errorBlock: {
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
  },
  errorText: {
    color: ink.muted,
  },
  section: {
    marginBottom: SPACING.sm,
  },
  sectionHeading: {
    color: ink.muted,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  entryRow: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: radius.sm,
  },
  entryRowSelected: {
    backgroundColor: surface.sunken,
  },
  entryLabel: {
    color: ink.primary,
  },
  entryDate: {
    color: ink.muted,
  },
});
