/**
 * ``JournalShelfScreen`` — the journal's landing surface: a shelf of entries as
 * dated pages (title + excerpt + date), a "New entry" action, and editorial
 * full-text search. Tapping a page opens the entry screen by id. Replaces the
 * old chat list; categorization is the AI's marginalia now, so there are no tags.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import styles from './JournalShelf.styles';
import SearchBar from './SearchBar';

import { journal, prompts } from '@/api';
import type { JournalMessage, PromptDetail } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useDerivedCurrentWeek } from '@/store/useProgramProgression';

const PAGE_SIZE = 20;
const SEARCH_MIN_LENGTH = 3;
const SEARCH_MAX_LENGTH = 64; // mirrors the backend JOURNAL_SEARCH_MAX_LENGTH guard
const EXCERPT_MAX = 140;

type ShelfNavigation = NativeStackNavigationProp<RootStackParamList>;

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX).trimEnd()}…` : flat;
}

/** A search query only hits the API once it clears the backend's min length. */
function searchParam(query: string): string | undefined {
  return query.length >= SEARCH_MIN_LENGTH ? query : undefined;
}

interface ShelfState {
  items: JournalMessage[];
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
  const [items, setItems] = useState<JournalMessage[]>([]);
  const [query, setQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string | undefined, offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await journal.list({ search, limit: PAGE_SIZE, offset });
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
      setHasMore(page.has_more);
    } catch (err) {
      // Surface the failure so a cold-start network error isn't mistaken for an
      // empty shelf; the current items (if any) stay in place for retry.
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  return { items, loading, error, query, hasMore, onSearch, loadMore };
}

function PageCard({
  entry,
  onOpen,
}: {
  entry: JournalMessage;
  onOpen: (_id: number) => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onOpen(entry.id)}
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
        {excerpt(entry.message)}
      </Text>
    </TouchableOpacity>
  );
}

function ShelfHeader({ onSearch, onNew }: { onSearch: (_q: string) => void; onNew: () => void }) {
  return (
    <View style={styles.header}>
      <SearchBar onSearch={onSearch} />
      <TouchableOpacity
        style={styles.newEntry}
        onPress={onNew}
        accessibilityRole="button"
        accessibilityLabel="New entry"
        testID="journal-new-entry"
      >
        <Text style={styles.newEntryLabel}>New entry</Text>
      </TouchableOpacity>
    </View>
  );
}

/** Empty-list state: nothing while loading, the load error, else the empty copy. */
function ShelfEmpty({ loading, error }: { loading: boolean; error: string | null }) {
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
  return (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyText} testID="journal-shelf-empty">
        Your shelf is empty — start a page.
      </Text>
    </View>
  );
}

/** The current unanswered weekly prompt, or null (answered / none / load error). */
function usePrompt(): PromptDetail | null {
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  useEffect(() => {
    let active = true;
    void prompts
      .current()
      .then((p) => {
        if (active && !p.has_responded) setPrompt(p);
      })
      .catch(() => {
        // A prompt fetch failure shouldn't block the shelf; just hide the card.
      });
    return () => {
      active = false;
    };
  }, []);
  return prompt;
}

/** The weekly prompt surfaced as a pre-titled page (tap → the entry screen). */
function PromptCard({
  week,
  question,
  onOpen,
}: {
  week: number;
  question: string;
  onOpen: () => void;
}) {
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

function JournalShelfScreen(): React.JSX.Element {
  const navigation = useNavigation<ShelfNavigation>();
  const { items, loading, error, hasMore, onSearch, loadMore } = useShelf();
  const prompt = usePrompt();
  const week = useDerivedCurrentWeek(prompt?.week_number ?? 1);

  const openEntry = useCallback(
    (entryId: number) => navigation.navigate('JournalEntry', { entryId }),
    [navigation],
  );
  const newEntry = useCallback(() => navigation.navigate('JournalEntry'), [navigation]);
  const openPrompt = useCallback(() => {
    if (!prompt) return;
    navigation.navigate('JournalEntry', {
      weekNumber: week,
      promptQuestion: prompt.question,
      prefillTitle: `Week ${week} Reflection`,
    });
  }, [navigation, prompt, week]);

  const header = (
    <>
      {prompt ? <PromptCard week={week} question={prompt.question} onOpen={openPrompt} /> : null}
      <ShelfHeader onSearch={onSearch} onNew={newEntry} />
    </>
  );

  return (
    <SafeAreaView style={styles.safeArea} testID="journal-shelf">
      <FlatList
        testID="journal-shelf-list"
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <PageCard entry={item} onOpen={openEntry} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<ShelfEmpty loading={loading} error={error} />}
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.4}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

export default JournalShelfScreen;
