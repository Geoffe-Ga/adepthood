/**
 * ``JournalShelfScreen`` — the journal's landing surface, restyled as an
 * editorial library: a warm ``ScreenScaffold`` whose scrolling top matter stacks
 * the ``JournalHero``, ``StatTileRow``, ``ReturnStack``, ``InvitationStack``, a
 * serif ``ScreenHeader``, the weekly prompt, a ``ReflectionInvitationBand``, and
 * ``SearchBar`` on the warm palette. Below it, entries group by recency (This
 * week / This month / Earlier) as lifted paper tiles with a reading-time +
 * "saved … ago" caption, over an inviting empty state with a call to action.
 * Tapping a page opens the entry screen by id.
 */
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { Animated, SectionList, Text, TouchableOpacity, View } from 'react-native';
import type { SectionListData, SectionListRenderItemInfo } from 'react-native';

import { excerpt } from './excerpt';
import { JournalScreenDrawer } from './JournalDrawer';
import JournalHero from './JournalHero';
import styles from './JournalShelf.styles';
import { usePressScale } from './motion';
import { promptTitleForWeek } from './promptTitle';
import { formatDate, groupByRecency, MONTH_DAYS, type ShelfSection } from './recency';
import ReflectionInvitationBand from './ReflectionInvitationBand';
import SearchBar from './SearchBar';
import StatTileRow from './StatTileRow';
import { usePagedJournal } from './usePagedJournal';

import { prompts } from '@/api';
import type { JournalMessage, PromptDetail } from '@/api';
import { Button } from '@/components/Button';
import { useScreenDrawer } from '@/components/drawer';
import { EmptyState } from '@/components/feedback/EmptyState';
import { BottomFade } from '@/components/layout/BottomFade';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
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

/** Estimated reading time in whole minutes (≥1). */
function readingMinutes(body: string): number {
  const trimmed = body.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
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
}

/** Out-of-range queries are dropped before hitting the API (avoids a 422). */
function isSearchable(next: string): boolean {
  return (
    next.length === 0 || (next.length >= SEARCH_MIN_LENGTH && next.length <= SEARCH_MAX_LENGTH)
  );
}

/** Loads the shelf with offset paging + debounced search (via SearchBar). */
function useShelf(): ShelfState {
  const { items, total, hasMore, loading, error, load } = usePagedJournal();
  const [query, setQuery] = useState('');

  useEffect(() => {
    void load(undefined, 0);
  }, [load]);

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

  return { items, total, loading, error, query, hasMore, onSearch, loadMore };
}

function PageCard({
  entry,
  onOpen,
  now,
}: {
  entry: JournalMessage;
  onOpen: (_id: number) => void;
  now: number;
}): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <TouchableOpacity
        style={styles.card}
        onPress={() => onOpen(entry.id)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={`Open ${entry.title ?? 'untitled'} entry`}
        testID={`journal-shelf-card-${entry.id}`}
      >
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {entry.title?.trim() ? entry.title : 'Untitled'}
          </Text>
          <Text style={styles.cardDate}>{formatDate(entry.timestamp)}</Text>
        </View>
        <Text style={styles.cardExcerpt} numberOfLines={2}>
          {excerpt(entry.message, EXCERPT_MAX)}
        </Text>
        <Text style={styles.cardCaption}>{pageCaption(entry, now)}</Text>
      </TouchableOpacity>
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
  onNew: () => void;
  onSearch: (_query: string) => void;
  query: string;
  resultCount?: number;
}

/** The scrolling head of the shelf: title + New entry, the prompt band, search. */
function ShelfTopMatter({
  prompt,
  week,
  onPrompt,
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
      <ScreenHeader
        title="Journal"
        action={<Button label="New entry" onPress={onNew} testID="journal-new-entry" />}
      />
      {prompt ? <PromptCard week={week} question={prompt.question} onOpen={onPrompt} /> : null}
      <ReflectionInvitationBand />
      <View style={styles.searchRow}>
        <SearchBar onSearch={onSearch} searchQuery={query || undefined} resultCount={resultCount} />
      </View>
    </View>
  );
}

interface ShelfNav {
  openEntry: (_id: number) => void;
  newEntry: () => void;
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
  return { openEntry, newEntry, openPrompt, openWithPrompt };
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
  return { drawer, onSelectEntry, onNewEntry };
}

interface ShelfBodyProps {
  shelf: ShelfState;
  nav: ShelfNav;
  prompt: PromptDetail | null;
  week: number;
  now: number;
}

/** The shelf's scrolling list surface (top matter, recency sections, paging) —
 *  split out so the screen component stays under the line cap. */
function ShelfBody({ shelf, nav, prompt, week, now }: ShelfBodyProps): React.JSX.Element {
  const { items, total, loading, error, query, hasMore, onSearch, loadMore } = shelf;
  const sections = groupByRecency(items, now);
  const searching = query.length >= SEARCH_MIN_LENGTH;
  const resultCount = searching ? total : undefined;

  const renderItem = ({ item }: SectionListRenderItemInfo<JournalMessage, ShelfSection>) => (
    <PageCard entry={item} onOpen={nav.openEntry} now={now} />
  );

  return (
    <SectionList
      style={styles.list}
      testID="journal-shelf-list"
      sections={sections}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <ShelfTopMatter
          prompt={prompt}
          week={week}
          onPrompt={nav.openPrompt}
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

function JournalShelfScreen(): React.JSX.Element {
  const navigation = useNavigation<ShelfNavigation>();
  const shelf = useShelf();
  const prompt = usePrompt();
  const week = useDerivedCurrentWeek(prompt?.week_number ?? 1);
  const nav = useShelfNavigation(navigation, prompt, week);
  const shelfDrawer = useShelfDrawer(nav);
  const now = Date.now();

  return (
    <ScreenScaffold testID="journal-shelf">
      <ShelfBody shelf={shelf} nav={nav} prompt={prompt} week={week} now={now} />
      <BottomFade />
      <JournalScreenDrawer
        drawer={shelfDrawer.drawer}
        onSelectEntry={shelfDrawer.onSelectEntry}
        onNewEntry={shelfDrawer.onNewEntry}
      />
    </ScreenScaffold>
  );
}

export default JournalShelfScreen;
