/**
 * ``JournalShelfScreen`` — the journal's landing surface, restyled as an
 * editorial library: a warm ``ScreenScaffold`` whose scrolling top matter stacks
 * the ``JournalHero``, ``StatTileRow``, ``ReturnStack``, ``InvitationStack``, a
 * "New entry" action row, the weekly prompt, a ``ReflectionInvitationBand``, a
 * ``MorningPagesTip``, and ``SearchBar`` on the warm palette. Below it, entries group by recency (This
 * week / This month / Earlier) as lifted paper tiles with a reading-time +
 * "saved … ago" caption, over an inviting empty state with a call to action.
 * Tapping a page opens the entry screen by id.
 */
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useRef, useState } from 'react';
import { Animated, SectionList, Text, TouchableOpacity, View } from 'react-native';
import type { SectionListData, SectionListRenderItemInfo } from 'react-native';

import { deleteEntryLabel } from './deleteEntryCopy';
import DeleteEntryDialog from './DeleteEntryDialog';
import { excerpt } from './excerpt';
import { JournalScreenDrawer } from './JournalDrawer';
import JournalHero from './JournalHero';
import styles from './JournalShelf.styles';
import MorningPagesTip from './MorningPagesTip';
import { usePressScale } from './motion';
import PromptHistoryModal from './PromptHistoryModal';
import { promptTitleForWeek } from './promptTitle';
import { formatDate, groupByRecency, MONTH_DAYS, type ShelfSection } from './recency';
import ReflectionInvitationBand from './ReflectionInvitationBand';
import SearchBar from './SearchBar';
import StatTileRow from './StatTileRow';
import { useEntryDeletion, type EntryDeletion } from './useEntryDeletion';
import { usePagedJournal } from './usePagedJournal';
import { countWords } from './wordCount';

import { prompts } from '@/api';
import type { JournalMessage, PromptDetail } from '@/api';
import { Button } from '@/components/Button';
import { useScreenDrawer } from '@/components/drawer';
import { EmptyState } from '@/components/feedback/EmptyState';
import { BottomFade } from '@/components/layout/BottomFade';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import InvitationStack from '@/features/Invitations/InvitationStack';
import ReturnStack from '@/features/Return/ReturnStack';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useDerivedCurrentWeek } from '@/store/useProgramProgression';
import { MS_PER_DAY } from '@/utils/dateUtils';

const SEARCH_MIN_LENGTH = 3;
const SEARCH_MAX_LENGTH = 64; // mirrors the backend JOURNAL_SEARCH_MAX_LENGTH guard
const EXCERPT_MAX = 140;
const WORDS_PER_MINUTE = 200;

// A single curated opening invitation for a brand-new journal (no rotation).
const FIRST_PROMPT = 'What brought you here?';

type ShelfNavigation = NativeStackNavigationProp<RootStackParamList>;

/**
 * Estimated reading time in whole minutes (≥1).
 *
 * Shares ``countWords`` with the writing page's live counter so a page never
 * reports a reading time computed from a different idea of what a word is —
 * a whitespace split counted a row of asterisks and undercounted em-dashed
 * prose.
 */
function readingMinutes(body: string): number {
  return Math.max(1, Math.ceil(countWords(body) / WORDS_PER_MINUTE));
}

/** A relative "saved …" phrase, falling back to the absolute date when old. */
function savedAgo(timestamp: string, now: number): string {
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return '';
  const age = Math.floor((now - ms) / MS_PER_DAY);
  if (age <= 0) return 'saved today';
  if (age === 1) return 'saved 1 day ago';
  if (age < MONTH_DAYS) return `saved ${age} days ago`;
  return `saved ${formatDate(timestamp)}`;
}

/** Reading-time + "saved … ago" caption for a page card. */
function pageCaption(entry: JournalMessage, now: number): string {
  const read = `${readingMinutes(entry.message)} min read`;
  const ago = savedAgo(entry.timestamp, now);
  return ago ? `${read} · ${ago}` : read;
}

/** A search query only hits the API once it clears the backend's min length. */
function searchParam(query: string): string | undefined {
  return query.length >= SEARCH_MIN_LENGTH ? query : undefined;
}

interface ShelfState {
  items: JournalMessage[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  hasMore: boolean;
  onSearch: (_query: string) => void;
  loadMore: () => void;
  /** The confirm-then-remove flow behind each row's delete affordance. */
  deletion: EntryDeletion;
}

/** Out-of-range queries are dropped before hitting the API (avoids a 422). */
function isSearchable(next: string): boolean {
  return (
    next.length === 0 || (next.length >= SEARCH_MIN_LENGTH && next.length <= SEARCH_MAX_LENGTH)
  );
}

/** Loads the shelf with offset paging + debounced search (via SearchBar).
 *
 * The first page is read on every focus, not just on mount: the shelf stays
 * mounted while the user pushes to the entry screen, so a page written there
 * would never reach a list that loaded once — the same reason the weekly prompt
 * card re-fetches, applied to the list it sits above. The read is skipped while
 * a confirmed delete is still in flight, where the local list is deliberately
 * ahead of the server and a landing page would resurrect the removed row.
 */
function useShelf(): ShelfState {
  const { items, setItems, total, adjustTotal, hasMore, loading, error, load } = usePagedJournal();
  const [query, setQuery] = useState('');
  const deletion = useEntryDeletion({ items, setItems, adjustTotal });
  const { isRemoving } = deletion;
  // Read inside the focus effect so the live query survives a return to the
  // shelf without making the effect fire on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;

  useFocusEffect(
    useCallback(() => {
      if (isRemoving()) return;
      void load(searchParam(queryRef.current), 0);
    }, [load, isRemoving]),
  );

  const onSearch = useCallback(
    (next: string) => {
      // 1-2 chars (or >64) hold the current view rather than 422 on the guard.
      if (!isSearchable(next)) return;
      setQuery(next);
      void load(searchParam(next), 0);
    },
    [load],
  );

  const loadMore = useCallback(() => {
    if (hasMore && !loading) void load(searchParam(query), items.length);
  }, [hasMore, loading, load, query, items.length]);

  return { items, total, loading, error, query, hasMore, onSearch, loadMore, deletion };
}

/** The page's own name, or the stand-in the shelf shows when it has none. */
function cardTitle(entry: JournalMessage): string {
  return entry.title?.trim() ? entry.title : 'Untitled';
}

interface PageCardProps {
  entry: JournalMessage;
  onOpen: (_id: number) => void;
  onDelete: (_entry: JournalMessage) => void;
  now: number;
}

/**
 * One page on the shelf: a paper tile holding a tappable reading face and,
 * beneath it, the delete affordance. The two are siblings rather than nested
 * touchables — a button inside an ``accessible`` touchable is grouped away
 * from VoiceOver, which would leave the delete reachable only by sight.
 */
function PageCard({ entry, onOpen, onDelete, now }: PageCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const title = cardTitle(entry);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID={`journal-shelf-card-${entry.id}`}>
        <TouchableOpacity
          onPress={() => onOpen(entry.id)}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          accessibilityRole="button"
          accessibilityLabel={`Open ${entry.title ?? 'untitled'} entry`}
          testID={`journal-shelf-open-${entry.id}`}
        >
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.cardDate}>{formatDate(entry.timestamp)}</Text>
          </View>
          <Text style={styles.cardExcerpt} numberOfLines={2}>
            {excerpt(entry.message, EXCERPT_MAX)}
          </Text>
          <Text style={styles.cardCaption}>{pageCaption(entry, now)}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.cardDeleteButton}
          onPress={() => onDelete(entry)}
          accessibilityRole="button"
          accessibilityLabel={deleteEntryLabel(title)}
          testID={`journal-shelf-delete-${entry.id}`}
        >
          <Text style={styles.cardDeleteLabel}>Delete</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

/** A serif recency band heading (This week / This month / Earlier). */
function SectionHeading({ title }: { title: string }): React.JSX.Element {
  return (
    <Text style={styles.sectionHeading} accessibilityRole="header">
      {title}
    </Text>
  );
}

interface ShelfEmptyProps {
  loading: boolean;
  error: string | null;
  searching: boolean;
  onNew: () => void;
  onFirstPrompt: () => void;
}

/** Empty list: nothing while loading, the load error, a no-results line for an
 * active search, else the inviting empty state with a CTA into a blank page. */
function ShelfEmpty({
  loading,
  error,
  searching,
  onNew,
  onFirstPrompt,
}: ShelfEmptyProps): React.JSX.Element | null {
  if (loading) return null;
  if (error != null) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyError} testID="journal-shelf-error">
          {error}
        </Text>
      </View>
    );
  }
  if (searching) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText} testID="journal-shelf-no-results">
          No pages match your search.
        </Text>
      </View>
    );
  }
  return (
    <EmptyState
      glyph="📖"
      title="Your journal is empty"
      body="Start your first page — a quiet place to think out loud."
      cta={
        <View style={styles.emptyCtaGroup}>
          <Button label="Start a page" onPress={onNew} testID="journal-empty-cta" />
          <Button
            label={FIRST_PROMPT}
            variant="tertiary"
            onPress={onFirstPrompt}
            accessibilityLabel="Begin a first page from the question: What brought you here?"
            testID="journal-empty-first-prompt"
          />
        </View>
      }
      testID="journal-shelf-empty"
    />
  );
}

/** The current unanswered weekly prompt, or null (answered / none / load error).
 *
 * Re-fetched on every focus (not just mount): the shelf stays mounted while the
 * user pushes to the entry screen, so after responding + going back the card
 * must clear — hence ``useFocusEffect`` and the explicit reset when answered.
 */
function usePrompt(): PromptDetail | null {
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void prompts
        .current()
        .then((p) => {
          if (active) setPrompt(p.has_responded ? null : p);
        })
        .catch(() => {
          // A prompt fetch failure shouldn't block the shelf; just hide the card.
        });
      return () => {
        active = false;
      };
    }, []),
  );
  return prompt;
}

/** The weekly prompt surfaced as its own pre-titled band (tap → the entry screen). */
function PromptCard({
  week,
  question,
  onOpen,
}: {
  week: number;
  question: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.promptCard}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Respond to the week ${week} prompt`}
      testID="journal-weekly-prompt"
    >
      <Text style={styles.promptLabel}>Week {week}</Text>
      <Text style={styles.promptQuestion}>{question}</Text>
    </TouchableOpacity>
  );
}

interface TopMatterProps {
  prompt: PromptDetail | null;
  week: number;
  onPrompt: () => void;
  onPastPrompts: () => void;
  onNew: () => void;
  onSearch: (_query: string) => void;
  query: string;
  resultCount?: number;
}

/** The scrolling head of the shelf: the New entry action, the prompt band, search.
 *
 * No screen title: the bottom tab already names this screen and the hero
 * greeting already carries ``accessibilityRole="header"``, so a serif display
 * "Journal" was a second display-scale moment stacked under the greeting.
 */
function ShelfTopMatter({
  prompt,
  week,
  onPrompt,
  onPastPrompts,
  onNew,
  onSearch,
  query,
  resultCount,
}: TopMatterProps): React.JSX.Element {
  return (
    <View>
      <JournalHero />
      <StatTileRow />
      <ReturnStack />
      <InvitationStack />
      <View style={styles.actionRow}>
        <Button
          label="Past prompts"
          variant="tertiary"
          onPress={onPastPrompts}
          accessibilityLabel="Read the weekly prompts you have already answered"
          testID="journal-past-prompts"
        />
        <Button label="New entry" onPress={onNew} testID="journal-new-entry" />
      </View>
      {prompt ? <PromptCard week={week} question={prompt.question} onOpen={onPrompt} /> : null}
      <ReflectionInvitationBand />
      <MorningPagesTip onBegin={onNew} />
      <View style={styles.searchRow}>
        <SearchBar onSearch={onSearch} searchQuery={query || undefined} resultCount={resultCount} />
      </View>
    </View>
  );
}

interface ShelfNav {
  openEntry: (_id: number) => void;
  newEntry: () => void;
  openPhotograph: () => void;
  openPrompt: () => void;
  openWithPrompt: () => void;
}

/** Memoized navigation callbacks for the shelf's three destinations. */
function useShelfNavigation(
  navigation: ShelfNavigation,
  prompt: PromptDetail | null,
  week: number,
): ShelfNav {
  const openEntry = useCallback(
    (entryId: number) => navigation.navigate('JournalEntry', { entryId }),
    [navigation],
  );
  const newEntry = useCallback(() => navigation.navigate('JournalEntry'), [navigation]);
  const openPhotograph = useCallback(() => navigation.navigate('JournalPhotograph'), [navigation]);
  const openWithPrompt = useCallback(
    () => navigation.navigate('JournalEntry', { promptQuestion: FIRST_PROMPT }),
    [navigation],
  );
  const openPrompt = useCallback(() => {
    if (!prompt) return;
    navigation.navigate('JournalEntry', {
      weekNumber: week,
      promptQuestion: prompt.question,
      prefillTitle: promptTitleForWeek(week),
    });
  }, [navigation, prompt, week]);
  return { openEntry, newEntry, openPhotograph, openPrompt, openWithPrompt };
}

function renderSectionHeader({
  section,
}: {
  section: SectionListData<JournalMessage, ShelfSection>;
}): React.JSX.Element {
  return <SectionHeading title={section.title} />;
}

interface ShelfDrawer {
  drawer: ReturnType<typeof useScreenDrawer>;
  onSelectEntry: (_id: number) => void;
  onNewEntry: () => void;
  onPhotograph: () => void;
}

/** The header drawer's open state plus its open-then-close row callbacks. From
 *  the shelf a row tap navigates (not pushes) to the entry, then closes. */
function useShelfDrawer(nav: ShelfNav): ShelfDrawer {
  const drawer = useScreenDrawer('Journal');
  const onSelectEntry = useCallback(
    (entryId: number) => {
      nav.openEntry(entryId);
      drawer.close();
    },
    [nav, drawer],
  );
  const onNewEntry = useCallback(() => {
    nav.newEntry();
    drawer.close();
  }, [nav, drawer]);
  const onPhotograph = useCallback(() => {
    nav.openPhotograph();
    drawer.close();
  }, [nav, drawer]);
  return { drawer, onSelectEntry, onNewEntry, onPhotograph };
}

/** A shelf row's renderer, bound to the callbacks and clock the screen holds. */
function makeRenderItem(
  nav: ShelfNav,
  shelf: ShelfState,
  now: number,
): (_info: SectionListRenderItemInfo<JournalMessage, ShelfSection>) => React.JSX.Element {
  return ({ item }) => (
    <PageCard entry={item} onOpen={nav.openEntry} onDelete={shelf.deletion.request} now={now} />
  );
}

interface ShelfBodyProps {
  shelf: ShelfState;
  nav: ShelfNav;
  prompt: PromptDetail | null;
  week: number;
  now: number;
  onPastPrompts: () => void;
}

/** The shelf's scrolling list surface (top matter, recency sections, paging) —
 *  split out so the screen component stays under the line cap. */
function ShelfBody({
  shelf,
  nav,
  prompt,
  week,
  now,
  onPastPrompts,
}: ShelfBodyProps): React.JSX.Element {
  const { items, total, loading, error, query, hasMore, onSearch, loadMore } = shelf;
  const sections = groupByRecency(items, now);
  const searching = query.length >= SEARCH_MIN_LENGTH;
  const resultCount = searching ? total : undefined;

  return (
    <SectionList
      style={styles.list}
      testID="journal-shelf-list"
      sections={sections}
      keyExtractor={(item) => String(item.id)}
      renderItem={makeRenderItem(nav, shelf, now)}
      renderSectionHeader={renderSectionHeader}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <ShelfTopMatter
          prompt={prompt}
          week={week}
          onPrompt={nav.openPrompt}
          onPastPrompts={onPastPrompts}
          onNew={nav.newEntry}
          onSearch={onSearch}
          query={query}
          resultCount={resultCount}
        />
      }
      ListEmptyComponent={
        <ShelfEmpty
          loading={loading}
          error={error}
          searching={searching}
          onNew={nav.newEntry}
          onFirstPrompt={nav.openWithPrompt}
        />
      }
      onEndReached={hasMore ? loadMore : undefined}
      onEndReachedThreshold={0.4}
      contentContainerStyle={styles.listContent}
    />
  );
}

/**
 * A refused delete, said where the row it concerns went back to. Renders
 * nothing on the healthy path, so the shelf stays quiet until it has to speak.
 */
function DeleteFailureNotice({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <Text style={styles.deleteError} testID="journal-delete-error">
      {message}
    </Text>
  );
}

function JournalShelfScreen(): React.JSX.Element {
  const navigation = useNavigation<ShelfNavigation>();
  const shelf = useShelf();
  const prompt = usePrompt();
  const week = useDerivedCurrentWeek(prompt?.week_number ?? 1);
  const nav = useShelfNavigation(navigation, prompt, week);
  const shelfDrawer = useShelfDrawer(nav);
  const { deletion } = shelf;
  const now = Date.now();
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  return (
    <ScreenScaffold testID="journal-shelf">
      <DeleteFailureNotice message={deletion.error} />
      <ShelfBody
        shelf={shelf}
        nav={nav}
        prompt={prompt}
        week={week}
        now={now}
        onPastPrompts={openHistory}
      />
      <PromptHistoryModal visible={historyOpen} onDismiss={closeHistory} />
      <BottomFade />
      <JournalScreenDrawer
        drawer={shelfDrawer.drawer}
        onSelectEntry={shelfDrawer.onSelectEntry}
        onNewEntry={shelfDrawer.onNewEntry}
        onPhotograph={shelfDrawer.onPhotograph}
      />
      <DeleteEntryDialog
        visible={deletion.pending !== null}
        onConfirm={deletion.confirm}
        onCancel={deletion.cancel}
      />
    </ScreenScaffold>
  );
}

export default JournalShelfScreen;
