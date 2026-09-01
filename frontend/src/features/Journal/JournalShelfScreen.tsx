/**
 * ``JournalShelfScreen`` — the journal's landing surface, restyled as an
 * editorial library: a warm ``ScreenScaffold`` whose scrolling top matter stacks
 * the ``JournalHero``, ``StatTileRow``, ``ReturnStack``, ``InvitationStack``, a
 * "New entry" action row, the current stage's prompts, a ``ReflectionInvitationBand``, a
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
import { formatDate, groupByRecency, MONTH_DAYS, type ShelfSection } from './recency';
import ReflectionInvitationBand from './ReflectionInvitationBand';
import SearchBar from './SearchBar';
import StatTileRow from './StatTileRow';
import { useEntryDeletion, type EntryDeletion } from './useEntryDeletion';
import { usePagedJournal } from './usePagedJournal';
import { countWords } from './wordCount';

import { prompts } from '@/api';
import type { JournalMessage, PromptDetail, StagePromptDetail, StagePromptsResponse } from '@/api';
import { Button } from '@/components/Button';
import { useScreenDrawer } from '@/components/drawer';
import { EmptyState } from '@/components/feedback/EmptyState';
import { BottomFade } from '@/components/layout/BottomFade';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import InvitationStack from '@/features/Invitations/InvitationStack';
import ReturnStack from '@/features/Return/ReturnStack';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  programStage,
  programStageForWeek,
  programWeek,
  useProgramStore,
} from '@/store/useProgramStore';
import { MS_PER_DAY } from '@/utils/dateUtils';

const SEARCH_MIN_LENGTH = 3;
const SEARCH_MAX_LENGTH = 64; // mirrors the backend JOURNAL_SEARCH_MAX_LENGTH guard
const EXCERPT_MAX = 140;
const WORDS_PER_MINUTE = 200;

// A single curated opening invitation for a brand-new journal (no rotation).
const FIRST_PROMPT = 'What brought you here?';

// Said of a prompt already written to. Deliberately a note, not a reward: the
// prompt stays open because several of them are meant to be returned to.
const ANSWERED_NOTE = 'Answered';

// Said once the week holds its one response. The server keeps a single response
// per week, so this names the rhythm rather than reporting a refusal — the whole
// set stays readable, just not writable until the week turns over.
const WEEK_WRITTEN_NOTE = "This week's prompt is written — the next one opens next week.";

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

/** The current week's prompt, or null while it loads (or after a load error).
 *
 * Read only to learn which program week a response belongs to — the cards below
 * come from the stage endpoint. Re-fetched on every focus (not just mount): the
 * shelf stays mounted while the user pushes to the entry screen, so a week that
 * turned over in between would otherwise keep composing against the old one.
 */
function useCurrentPrompt(): PromptDetail | null {
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void prompts
        .current()
        .then((p) => {
          if (active) setPrompt(p);
        })
        .catch(() => {
          // A prompt fetch failure shouldn't block the shelf; the week falls back.
        });
      return () => {
        active = false;
      };
    }, []),
  );
  return prompt;
}

/** A stage's prompts, plus the ordinals of the ones already written to. */
interface StagePromptsState {
  stage: StagePromptsResponse | null;
  answered: ReadonlySet<number>;
  /** False once this week already holds its one response.
   *
   * The server stores at most one response per (reader, week), whichever of the
   * stage's prompts it answers. Offering a second tap in the same week would
   * send the reader to a page whose every save is refused and whose writing is
   * therefore stored nowhere, so the band stops inviting one and says why.
   */
  writable: boolean;
}

const NO_STAGE_PROMPTS: StagePromptsState = {
  stage: null,
  answered: new Set<number>(),
  writable: true,
};

/** Ordinals of *this* stage's prompts the reader has already answered.
 *
 * Read from the response history rather than from the stage payload, which
 * describes the curriculum and knows nothing about this reader. Ordinals repeat
 * across stages, so a stored response only counts when its week falls inside
 * this stage; a response with no ordinal predates individually addressable
 * prompts and is skipped rather than credited to a prompt it may not answer.
 */
function answeredOrdinals(items: readonly PromptDetail[], stage: number): ReadonlySet<number> {
  const answered = new Set<number>();
  for (const item of items) {
    const ordinal = item.prompt_ordinal;
    if (ordinal != null && programStageForWeek(item.week_number) === stage) answered.add(ordinal);
  }
  return answered;
}

/** The current stage's whole prompt set, re-read on focus.
 *
 * A stage the reader has not reached is refused server-side, and any refusal
 * simply hides the section — the shelf never fails to render because prompts
 * did not load. The history read is allowed to fail on its own: the prompts
 * still appear, merely unmarked and still writable, rather than vanishing
 * because one of two reads failed.
 */
function useStagePrompts(stage: number | null, week: number | null): StagePromptsState {
  const [state, setState] = useState<StagePromptsState>(NO_STAGE_PROMPTS);
  useFocusEffect(
    useCallback(() => {
      // Neither read fires until the reader's place is actually known: a guessed
      // week would fetch — and offer — some other stage's prompts.
      if (stage === null || week === null) return undefined;
      let active = true;
      const load = async (): Promise<void> => {
        // Read together, not in sequence: the history is only used to mark the
        // cards, so making it wait on the curriculum read would delay the whole
        // section behind a request nothing renders directly.
        const [stagePrompts, history] = await Promise.all([
          prompts.stage(stage),
          prompts.history().catch(() => null),
        ]);
        if (!active) return;
        const items = history?.items ?? [];
        setState({
          stage: stagePrompts,
          answered: answeredOrdinals(items, stage),
          writable: !items.some((item) => item.week_number === week),
        });
      };
      void load().catch(() => {
        // A prompt fetch failure shouldn't block the shelf; just hide the section.
      });
      return () => {
        active = false;
      };
    }, [stage, week]),
  );
  return state;
}

/** What a prompt card says: the prompt, its cadence, and whether it is answered. */
function StagePromptFace({
  prompt,
  answered,
}: {
  prompt: StagePromptDetail;
  answered: boolean;
}): React.JSX.Element {
  const { ordinal, title, cadence } = prompt;
  return (
    <>
      <Text style={styles.promptQuestion}>{title}</Text>
      {cadence == null ? null : (
        <Text style={styles.promptLabel} testID={`journal-stage-prompt-cadence-${ordinal}`}>
          {cadence}
        </Text>
      )}
      {answered ? (
        <Text style={styles.promptAnswered} testID={`journal-stage-prompt-answered-${ordinal}`}>
          {ANSWERED_NOTE}
        </Text>
      ) : null}
    </>
  );
}

/** One of the stage's prompts: what it asks, and how often it asks it.
 *
 * Pressable only while the week can still take a response. Once it holds one,
 * the card is a plain reading surface rather than a button that leads to a page
 * the server refuses to save — the section says why just above it.
 */
function StagePromptCard({
  prompt,
  answered,
  writable,
  onOpen,
}: {
  prompt: StagePromptDetail;
  answered: boolean;
  writable: boolean;
  onOpen: (_prompt: StagePromptDetail) => void;
}): React.JSX.Element {
  const { ordinal, title } = prompt;
  const cardStyle = [styles.promptCard, answered ? styles.promptCardAnswered : null];
  const testID = `journal-stage-prompt-${ordinal}`;
  if (!writable) {
    return (
      <View style={cardStyle} accessibilityLabel={`The prompt: ${title}`} testID={testID}>
        <StagePromptFace prompt={prompt} answered={answered} />
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={cardStyle}
      onPress={() => onOpen(prompt)}
      accessibilityRole="button"
      accessibilityLabel={`${answered ? 'Write again to' : 'Write to'} the prompt: ${title}`}
      testID={testID}
    >
      <StagePromptFace prompt={prompt} answered={answered} />
    </TouchableOpacity>
  );
}

/** The stage's prompts as one band, in curriculum order — the order matters,
 *  since some stages' prompts are a sequence where each feeds the next. Renders
 *  nothing at all until a stage has loaded, so the shelf never shows a
 *  placeholder standing in for a prompt the server has not named yet. */
function StagePromptSection({
  state,
  onOpen,
}: {
  state: StagePromptsState;
  onOpen: (_prompt: StagePromptDetail) => void;
}): React.JSX.Element | null {
  const { stage, answered, writable } = state;
  if (stage === null || stage.prompts.length === 0) return null;
  return (
    <View style={styles.promptSection} testID="journal-stage-prompts">
      <Text style={styles.promptSectionLabel}>{`${stage.stage_name} prompts`}</Text>
      {writable ? null : (
        <Text style={styles.promptSectionNote} testID="journal-stage-prompts-week-written">
          {WEEK_WRITTEN_NOTE}
        </Text>
      )}
      {stage.prompts.map((prompt) => (
        <StagePromptCard
          key={prompt.ordinal}
          prompt={prompt}
          answered={answered.has(prompt.ordinal)}
          writable={writable}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

interface TopMatterProps {
  stagePrompts: StagePromptsState;
  onPrompt: (_prompt: StagePromptDetail) => void;
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
  stagePrompts,
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
      <StagePromptSection state={stagePrompts} onOpen={onPrompt} />
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
  openPrompt: (_prompt: StagePromptDetail) => void;
  openWithPrompt: () => void;
}

/** Memoized navigation callbacks for the shelf's three destinations. */
function useShelfNavigation(navigation: ShelfNavigation, week: number | null): ShelfNav {
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
  // Compose against *this* prompt: its ordinal is what tells the server which of
  // the stage's prompts the page answers, and its own curriculum headline is the
  // title — the server owns both strings, so the client derives neither. A null
  // week means the reader's place is unknown, in which case no prompt card is on
  // screen to press; filing the page under a guessed week would be worse than
  // doing nothing.
  const openPrompt = useCallback(
    (prompt: StagePromptDetail) => {
      if (week === null) return;
      navigation.navigate('JournalEntry', {
        weekNumber: week,
        promptOrdinal: prompt.ordinal,
        promptQuestion: prompt.body,
        prefillTitle: prompt.title,
      });
    },
    [navigation, week],
  );
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
  stagePrompts: StagePromptsState;
  now: number;
  onPastPrompts: () => void;
}

/** The shelf's scrolling list surface (top matter, recency sections, paging) —
 *  split out so the screen component stays under the line cap. */
function ShelfBody({
  shelf,
  nav,
  stagePrompts,
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
          stagePrompts={stagePrompts}
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
  const prompt = useCurrentPrompt();
  const anchor = useProgramStore((s) => s.programStartDate);
  // The local program anchor decides the week and stage when there is one; the
  // server's current week stands in until (and if) that anchor is set. With
  // neither — no anchor, and a refused ``/prompts/current`` — the place stays
  // null instead of falling back to week 1, because that guess would show
  // another stage's prompts and file the response under a week nobody is in.
  const week = programWeek(anchor) ?? prompt?.week_number ?? null;
  const stage = week === null ? null : (programStage(anchor) ?? programStageForWeek(week));
  const stagePrompts = useStagePrompts(stage, week);
  const nav = useShelfNavigation(navigation, week);
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
        stagePrompts={stagePrompts}
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
