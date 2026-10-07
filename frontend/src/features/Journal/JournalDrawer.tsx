/**
 * The Journal header-drawer body: a New-entry row pinned on top, then the user's
 * past entries grouped by recency (This week / This month / Earlier, newest
 * first, empty bands dropped), a tappable "Load older entries" row, a spinner
 * while the first page loads, and an error+retry: full-panel before any entry
 * loads, inline beneath the entries (in Load older's place) when a later page
 * fails.
 *
 * Entries are fetched lazily on the drawer's first open via the co-located
 * ``useJournalDrawerEntries`` hook, which lives above the ``ScreenDrawer`` panel
 * so its cache survives close/reopen (mirrors ``useCourseDrawerContent``).
 */
import { Camera, Library, Quote, ScrollText, SquarePen } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { corpusDestinationForReadiness, type CorpusDestination } from './corpusDestination';
import { groupByRecency, formatDate, type ShelfSection } from './recency';
import { usePagedJournal } from './usePagedJournal';

import { corpus, type JournalMessage } from '@/api';
import {
  DrawerItem,
  DrawerNavSection,
  DrawerSearchField,
  NAV_ICON_SIZE,
  NAV_ICON_STROKE,
  rankMatches,
  ScreenDrawer,
  SearchSweepStatus,
  sweepStatusFrom,
  useDrawerSearch,
  type DrawerSearchState,
  type ScreenDrawerState,
} from '@/components/drawer';
import { accent, ink, radius, SPACING, surface, touchTarget, type } from '@/design/tokens';
import { fetchVaultConnectionState } from '@/features/Settings/useVaultConnectionState';

/** Row that starts a fresh, blank entry. */
const NEW_ENTRY_LABEL = 'New entry';
/** Row that opens the photograph-a-page capture flow. */
const PHOTOGRAPH_LABEL = 'Photograph a page';
/** Permanent door to the writing corpus behind reflections. */
const CORPUS_LABEL = "Everything you've written";
/**
 * Permanent door to the shelf of expanded margin notes.
 *
 * A label and nothing else. The listing route hands back a ``total``, so a
 * count or a badge would cost one line here — and this row is exactly where
 * one would go. It stays a door: NORTH-STAR §3 ("you choose your depth") and
 * §6 make invitations resonant and declinable, and a number beside a row is
 * neither. The shelf is retrieval, reached because someone went looking.
 */
const VOICE_DRAFTS_LABEL = 'Voice drafts';
/**
 * Permanent door to every quote the writer has promoted, across entries (#2865).
 *
 * A door with no count, for the reason ``VOICE_DRAFTS_LABEL`` gives: the
 * listing's totals are spent on the screen's own section headers, reached
 * because the writer went looking, and never on a number beside this row.
 */
export const PROMOTED_QUOTES_LABEL = 'Promoted quotes';
const CORPUS_ERROR = "Couldn't open your writing just now. Check your connection and try again.";
/** Row that fetches and appends the next page of older entries. */
const LOAD_MORE_LABEL = 'Load older entries';
/** Fallback label for an entry saved without a title. */
const UNTITLED_LABEL = 'Untitled';
/** Test hook for the drawer's search-field wrapper (and its sweep-status rows). */
const SEARCH_TESTID = 'journal-drawer-search';
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
/** Quiet caption shown while the confirm-triggered deep-search sweep is running. */
const SEARCH_LOADING_LABEL = 'Searching all your entries...';
/** Quiet caption shown when the deep-search sweep failed, above its retry row. */
const SEARCH_ERROR_LABEL = 'We could not finish searching your entries.';
/** The entry-specific identity and copy the shared search field renders. */
const SEARCH_FIELD_COPY = {
  testID: SEARCH_TESTID,
  placeholder: SEARCH_PLACEHOLDER,
  accessibilityLabel: SEARCH_ACCESSIBILITY_LABEL,
  deepSearchLabel: DEEP_SEARCH_LABEL,
};

/**
 * Fetch the drawer's entries lazily on its first open and cache them across
 * close/reopen. The first fetch pulls page 0; ``loadMore`` appends the next page
 * (offset = current count) and is guarded so a concurrent or duplicate press is
 * a no-op; ``retry`` asks again for the page that failed (offset = rows held,
 * so page 0 when none are).
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
    // After a failed load-more or a partial sweep the rows held equal the failed
    // offset; with none held this is page 0 (#2997, the #2902 precedent).
    void load(undefined, items.length);
  }, [load, items.length]);

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
      <Text
        style={[type(width).body, styles.errorText]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        {ERROR_LABEL}
      </Text>
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

/**
 * The rows below the pinned New-entry row: a spinner, or the grouped list ending
 * in either the error+retry or Load older. A failure never hides the entries
 * already held: it takes Load older's place beneath them, and with none held it
 * is all the panel shows (#2997). ``loading`` and ``error`` never coexist --
 * every load clears the error as it starts.
 */
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
      {error ? (
        <DrawerError onRetry={onRetry} />
      ) : hasMore ? (
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

interface SearchViewProps {
  matches: JournalMessage[];
  bodySearchActive: boolean;
  loading: boolean;
  error: boolean;
  currentEntryId?: number | null;
  onRowPress: (_id: number) => void;
  onConfirmBodySearch: () => void;
}

/** The active-query view: the sweep status row above the flat, ranked matches. */
function SearchView({
  matches,
  bodySearchActive,
  loading,
  error,
  currentEntryId,
  onRowPress,
  onConfirmBodySearch,
}: SearchViewProps): React.JSX.Element {
  return (
    <View>
      <SearchSweepStatus
        active={bodySearchActive}
        status={sweepStatusFrom(loading, error)}
        onRetry={onConfirmBodySearch}
        testIDPrefix={SEARCH_TESTID}
        loadingLabel={SEARCH_LOADING_LABEL}
        errorLabel={SEARCH_ERROR_LABEL}
      />
      <SearchResults matches={matches} currentEntryId={currentEntryId} onRowPress={onRowPress} />
    </View>
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
  /** Open the photograph-a-page capture flow. Omitted where the flow is unavailable. */
  onPhotograph?: () => void;
  /** Open the consent decision or corpus import surface, as readiness requires. */
  onOpenCorpus: () => void;
  /** Open the Voice Drafts shelf. Carries no count — see ``VOICE_DRAFTS_LABEL``. */
  onOpenVoiceDrafts: () => void;
  /** Open the Promoted quotes screen. Carries no count — see ``PROMOTED_QUOTES_LABEL``. */
  onOpenPromotedQuotes: () => void;
  /** Status of the readiness lookup started by the corpus row. */
  corpusOpenState: CorpusOpenState;
  /** Fetch and append the next older page. */
  onLoadMore: () => void;
  /** Ask again for the page that failed: the next page when rows are held, page 0 when none. */
  onRetry: () => void;
  /**
   * Confirm the deep body search: the host pulls in every remaining older page
   * so the subsequent match runs against titles and message bodies alike.
   */
  onConfirmBodySearch: () => void;
}

interface JournalDrawerSearchState extends Omit<DrawerSearchState, 'query'> {
  /** The entries ranked against the active query, or every entry when idle. */
  matches: JournalMessage[];
}

/**
 * The shared drawer query and body-search gate, plus the ranked matches they
 * select: titles always, and each entry's message too once body search is on.
 */
function useJournalDrawerSearch(
  items: JournalMessage[],
  onConfirmBodySearch: () => void,
): JournalDrawerSearchState {
  const { query, bodySearchActive, isSearching, handleQueryChange, handleConfirmDeepSearch } =
    useDrawerSearch(onConfirmBodySearch);
  const getText = (entry: JournalMessage): string =>
    bodySearchActive ? `${entryLabel(entry)} ${entry.message}` : entryLabel(entry);
  const matches = isSearching ? rankMatches(query, items, getText) : items;

  return { bodySearchActive, isSearching, matches, handleQueryChange, handleConfirmDeepSearch };
}

/**
 * The drawer's top action rows: start a blank entry, optionally photograph a
 * page, and always tend the corpus behind reflections.
 */
function DrawerActions({
  onNewEntry,
  onPhotograph,
  onOpenCorpus,
  onOpenVoiceDrafts,
  onOpenPromotedQuotes,
  corpusOpenState,
}: {
  onNewEntry: () => void;
  onPhotograph?: () => void;
  onOpenCorpus: () => void;
  onOpenVoiceDrafts: () => void;
  onOpenPromotedQuotes: () => void;
  corpusOpenState: CorpusOpenState;
}): React.JSX.Element {
  return (
    <>
      <DrawerItem
        testID="journal-drawer-new-entry"
        label={NEW_ENTRY_LABEL}
        icon={<SquarePen color={ink.muted} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />}
        onPress={onNewEntry}
      />
      {onPhotograph ? (
        <DrawerItem
          testID="journal-photograph-entry"
          label={PHOTOGRAPH_LABEL}
          icon={<Camera color={ink.muted} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />}
          onPress={onPhotograph}
        />
      ) : null}
      <CorpusDrawerAction state={corpusOpenState} onPress={onOpenCorpus} />
      <DrawerItem
        testID="journal-drawer-voice-drafts"
        label={VOICE_DRAFTS_LABEL}
        icon={<ScrollText color={ink.muted} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />}
        onPress={onOpenVoiceDrafts}
      />
      <DrawerItem
        testID="journal-drawer-promoted-quotes"
        label={PROMOTED_QUOTES_LABEL}
        icon={<Quote color={ink.muted} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />}
        onPress={onOpenPromotedQuotes}
      />
    </>
  );
}

/** Permanent corpus door plus local progress/failure feedback for its live lookup. */
function CorpusDrawerAction({
  state,
  onPress,
}: {
  state: CorpusOpenState;
  onPress: () => void;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const accessibilityLabel =
    state === 'pending'
      ? "Opening everything you've written"
      : state === 'error'
        ? "Everything you've written. It didn't open last time; try again"
        : CORPUS_LABEL;
  return (
    <>
      <DrawerItem
        testID="journal-drawer-corpus"
        label={CORPUS_LABEL}
        icon={<Library color={ink.muted} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />}
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
      />
      {state === 'error' ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[type(width).caption, styles.corpusError]}
        >
          {CORPUS_ERROR}
        </Text>
      ) : null}
    </>
  );
}

/** The Journal header drawer's contents: New entry, a search field, then the list. */
export default function JournalDrawer(props: JournalDrawerProps): React.JSX.Element {
  const { bodySearchActive, isSearching, matches, handleQueryChange, handleConfirmDeepSearch } =
    useJournalDrawerSearch(props.items, props.onConfirmBodySearch);

  return (
    <View testID="journal-drawer">
      <DrawerActions
        onNewEntry={props.onNewEntry}
        onPhotograph={props.onPhotograph}
        onOpenCorpus={props.onOpenCorpus}
        onOpenVoiceDrafts={props.onOpenVoiceDrafts}
        onOpenPromotedQuotes={props.onOpenPromotedQuotes}
        corpusOpenState={props.corpusOpenState}
      />
      <DrawerSearchField
        {...SEARCH_FIELD_COPY}
        resultCount={isSearching ? matches.length : undefined}
        bodySearchActive={bodySearchActive}
        onQueryChange={handleQueryChange}
        onConfirmDeepSearch={handleConfirmDeepSearch}
      />
      {isSearching ? (
        <SearchView
          matches={matches}
          bodySearchActive={bodySearchActive}
          loading={props.loading}
          error={props.error}
          currentEntryId={props.currentEntryId}
          onRowPress={props.onRowPress}
          onConfirmBodySearch={props.onConfirmBodySearch}
        />
      ) : (
        <DrawerBody
          sections={groupByRecency(props.items, props.now)}
          loading={props.loading}
          error={props.error}
          hasMore={props.hasMore}
          currentEntryId={props.currentEntryId}
          onRowPress={props.onRowPress}
          onLoadMore={props.onLoadMore}
          onRetry={props.onRetry}
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
  /** Open the photograph-a-page capture flow. Omitted where it is unavailable. */
  onPhotograph?: () => void;
  /** Navigate through the corpus door once the shared readiness rule resolves it. */
  onOpenCorpus: (_destination: CorpusDestination) => void;
  /** Open the Voice Drafts shelf, closing the drawer behind it. */
  onOpenVoiceDrafts: () => void;
  /** Open the Promoted quotes screen, closing the drawer behind it. */
  onOpenPromotedQuotes: () => void;
}

type CorpusOpenState = 'idle' | 'pending' | 'error';

interface CorpusOpenAction {
  open: () => void;
  state: CorpusOpenState;
}

/** Resolve and open the corpus door once, cancelling a slow read if the drawer closes. */
function useOpenCorpusFromDrawer(
  drawer: ScreenDrawerState,
  onOpenCorpus: (_destination: CorpusDestination) => void,
): CorpusOpenAction {
  const requestGeneration = useRef(0);
  const requestPending = useRef(false);
  const [state, setState] = useState<CorpusOpenState>('idle');
  const { close, isOpen } = drawer;

  useEffect(() => {
    if (!isOpen) {
      requestGeneration.current += 1;
      requestPending.current = false;
      setState('idle');
    }
    return () => {
      requestGeneration.current += 1;
      requestPending.current = false;
    };
  }, [isOpen]);

  const open = useCallback(() => {
    if (requestPending.current) return;
    requestPending.current = true;
    setState('pending');
    const generation = requestGeneration.current;
    // The vault is read beside readiness (#3017): a corpus lives in a vault,
    // so this door must agree with the band and the hub. A failed vault read
    // resolves unknown, never an error here -- only readiness can fail the door.
    void Promise.all([corpus.voiceReadiness(), fetchVaultConnectionState()])
      .then(([readiness, vault]) => {
        if (generation !== requestGeneration.current) return;
        close();
        onOpenCorpus(corpusDestinationForReadiness(readiness, vault));
      })
      .catch(() => {
        if (generation === requestGeneration.current) setState('error');
      })
      .finally(() => {
        if (generation === requestGeneration.current) requestPending.current = false;
      });
  }, [close, onOpenCorpus]);

  return { open, state };
}

/** The Journal header drawer wired to its lazy, cache-above-the-panel entry fetch. */
export function JournalScreenDrawer({
  drawer,
  currentEntryId,
  onSelectEntry,
  onNewEntry,
  onPhotograph,
  onOpenCorpus,
  onOpenVoiceDrafts,
  onOpenPromotedQuotes,
}: JournalScreenDrawerProps): React.JSX.Element {
  const { items, loading, error, hasMore, loadMore, retry, confirmBodySearch } =
    useJournalDrawerEntries(drawer.isOpen);
  const corpusAction = useOpenCorpusFromDrawer(drawer, onOpenCorpus);

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
        onPhotograph={onPhotograph}
        onOpenCorpus={corpusAction.open}
        onOpenVoiceDrafts={onOpenVoiceDrafts}
        onOpenPromotedQuotes={onOpenPromotedQuotes}
        corpusOpenState={corpusAction.state}
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
  corpusError: {
    color: ink.muted,
    paddingBottom: SPACING.xs,
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
