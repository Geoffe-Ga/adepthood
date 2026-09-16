/**
 * ``VoiceDraftsShelfScreen`` (#2608) — the writer's expanded margin notes read
 * as one body of work, newest letter first.
 *
 * Retrieval, not an invitation. The listing route says so in its own docstring
 * and the screen must not undo it: there is no badge, no count, no "you have N
 * letters" line and no unread mark anywhere below, and the shelf is reached
 * only by a door the writer opens (the Journal drawer's Voice-drafts row).
 * NORTH-STAR §3 ("you choose your depth") and §6 govern invitations; a shelf
 * someone chooses to open is not one, and a number on the way in would make it
 * one. The server volunteers ``total`` so paging can end; it is spent on that
 * and nothing else.
 *
 * Each row carries the words the letter grew from. Opening a row opens the
 * letter itself with no further request — the listing already carries every
 * essay — and from the letter the writer can walk back to the page it was
 * written in the margin of.
 *
 * Drafts belonging to an intimate page are shown exactly as the server sends
 * them. This is the owner reading their own letter on their own device, and
 * ``GET /{entry_id}/marginalia`` already hands back the same prose today; the
 * egress question belongs to the vault mirror, never to a local read.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';

import { excerpt } from './excerpt';
import JournalModalShell from './JournalModalShell';
import { formatDate } from './recency';
import styles from './VoiceDraftsShelf.styles';

import { voiceDrafts, type VoiceDraft, type VoiceDraftListResponse } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/** How much of a letter a shelf row previews before the reader opens it. */
const EXCERPT_LENGTH = 160;

const SCREEN_TITLE = 'Voice drafts';
const SCREEN_EYEBROW = 'In your own words';
const SCREEN_LEAD =
  'Margin notes you asked to hear out at length. They keep, and they wait for nothing.';
const EMPTY_TITLE = 'No letters yet.';
const EMPTY_BODY =
  'When a margin note is worth hearing out at length, the letter it becomes is kept here.';
const LOAD_MORE_LABEL = 'Older letters';
const ERROR_LABEL = 'We could not reach your letters.';
const RETRY_LABEL = 'Tap to try again';
const CLOSE_LABEL = 'Close';
const OPEN_PAGE_LABEL = 'Open the page this came from';

type ShelfNavigation = NativeStackNavigationProp<RootStackParamList>;

interface ShelfState {
  items: VoiceDraft[];
  loading: boolean;
  /** Null until a read fails; holds the sentence the reader is shown. */
  error: string | null;
  hasMore: boolean;
  /** False until the first read settles, so an empty list is never shown early. */
  settled: boolean;
}

const INITIAL_STATE: ShelfState = {
  items: [],
  loading: true,
  error: null,
  hasMore: false,
  settled: false,
};

interface Shelf extends ShelfState {
  /** Fetch and append the next page; a no-op while one is in flight. */
  loadMore: () => void;
  /** Re-read from the top after a failure. */
  retry: () => void;
}

/** Updater marking a read as begun, keeping whatever is already on the shelf. */
function reading(previous: ShelfState): ShelfState {
  return { ...previous, loading: true, error: null };
}

/**
 * Updater that lands a page: the first one replaces the shelf, a later one is
 * appended, so a retry cannot leave a stale tail behind a fresh head.
 */
function pageLanded(page: VoiceDraftListResponse, offset: number) {
  return (previous: ShelfState): ShelfState => ({
    items: offset === 0 ? page.items : [...previous.items, ...page.items],
    loading: false,
    error: null,
    hasMore: page.has_more,
    settled: true,
  });
}

/** Updater that records a failed read without discarding what was already read. */
function readFailed(message: string) {
  return (previous: ShelfState): ShelfState => ({
    ...previous,
    loading: false,
    error: message,
    settled: true,
  });
}

/**
 * Own the shelf's pages: read the first on mount, append on demand, and start
 * over on retry.
 *
 * Reads are numbered by a generation counter rather than a boolean, so a page
 * still in flight when the reader retries settles into nothing instead of
 * appending itself behind the fresh first page.
 */
function useVoiceDraftShelf(): Shelf {
  const [state, setState] = useState<ShelfState>(INITIAL_STATE);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const read = useCallback((offset: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    setState(reading);
    voiceDrafts
      .list({ offset })
      .then((page) => {
        if (mine !== generation.current) return;
        setState(pageLanded(page, offset));
      })
      .catch((failure: unknown) => {
        if (mine !== generation.current) return;
        setState(readFailed(formatApiError(failure)));
      })
      .finally(() => {
        if (mine === generation.current) inFlight.current = false;
      });
  }, []);

  useEffect(() => {
    read(0);
  }, [read]);

  const { hasMore, loading, items } = state;
  const loadMore = useCallback(() => {
    // Ignore a press while a page is already in flight or none remain.
    if (hasMore && !loading) read(items.length);
  }, [hasMore, loading, items.length, read]);

  const retry = useCallback(() => {
    // Abandon whatever is in flight so its page cannot land after this one.
    generation.current += 1;
    inFlight.current = false;
    read(0);
  }, [read]);

  return { ...state, loadMore, retry };
}

/** One letter on the shelf: the words it grew from, a taste of it, and its date. */
function DraftCard({
  item,
  onOpen,
}: {
  item: VoiceDraft;
  onOpen: (_draft: VoiceDraft) => void;
}): React.JSX.Element {
  const written = formatDate(item.essay_generated_at);
  return (
    <TouchableOpacity
      testID={`voice-draft-${item.marginalia_id}`}
      accessibilityRole="button"
      accessibilityLabel={written ? `${item.anchor_text}, ${written}` : item.anchor_text}
      onPress={() => onOpen(item)}
      style={styles.card}
    >
      <Text style={styles.cardAnchor} numberOfLines={2}>
        {`“${item.anchor_text}”`}
      </Text>
      <Text style={styles.cardExcerpt} numberOfLines={2}>
        {excerpt(item.essay, EXCERPT_LENGTH)}
      </Text>
      {written ? <Text style={styles.cardDate}>{written}</Text> : null}
    </TouchableOpacity>
  );
}

/** The first-run state: the shelf is empty because nothing has been asked for yet. */
function EmptyShelf(): React.JSX.Element {
  return (
    <View testID="voice-drafts-empty" style={styles.emptyBlock}>
      <Text style={styles.emptyTitle}>{EMPTY_TITLE}</Text>
      <Text style={styles.emptyBody}>{EMPTY_BODY}</Text>
    </View>
  );
}

/** The failure state: what happened, and a way to ask again. */
function ShelfError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <View testID="voice-drafts-error" style={styles.errorBlock}>
      <Text style={styles.errorText}>{ERROR_LABEL}</Text>
      <Text style={styles.errorText}>{message}</Text>
      <TouchableOpacity
        testID="voice-drafts-retry"
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.actionRow}
      >
        <Text style={styles.actionText}>{RETRY_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The letter itself, opened straight from the page already in hand.
 *
 * Deliberately not a fetch: the listing carries every essay in full, so opening
 * one costs nothing and works with no connection at all.
 */
function LetterCard({
  draft,
  onClose,
  onOpenPage,
}: {
  draft: VoiceDraft | null;
  onClose: () => void;
  onOpenPage: (_draft: VoiceDraft) => void;
}): React.JSX.Element {
  const written = draft ? formatDate(draft.essay_generated_at) : '';
  return (
    <JournalModalShell
      visible={draft !== null}
      onDismiss={onClose}
      scrimTestID="voice-draft-scrim"
      scrimLabel="Dismiss letter"
      modalTestID="voice-draft-letter"
      cardStyle={styles.letterCard}
    >
      <View style={styles.letterHeader}>
        <Text style={styles.letterDate}>{written}</Text>
        <TouchableOpacity
          testID="voice-draft-close"
          accessibilityRole="button"
          accessibilityLabel={CLOSE_LABEL}
          onPress={onClose}
        >
          <Text style={styles.letterClose}>{CLOSE_LABEL}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.letterQuote}>{draft ? `“${draft.anchor_text}”` : ''}</Text>
      <ScrollView contentContainerStyle={styles.letterScroll}>
        <Text testID="voice-draft-letter-text" style={styles.letterBody}>
          {draft?.essay}
        </Text>
      </ScrollView>
      <TouchableOpacity
        testID="voice-draft-open-page"
        accessibilityRole="button"
        onPress={() => {
          if (draft !== null) onOpenPage(draft);
        }}
        style={styles.letterFooter}
      >
        <Text style={styles.letterFooterText}>{OPEN_PAGE_LABEL}</Text>
      </TouchableOpacity>
    </JournalModalShell>
  );
}

/** The rows beneath the header: spinner, failure, the first-run state, or letters. */
function ShelfBody({
  shelf,
  onOpen,
}: {
  shelf: Shelf;
  onOpen: (_draft: VoiceDraft) => void;
}): React.JSX.Element {
  if (shelf.error !== null && shelf.items.length === 0) {
    return <ShelfError message={shelf.error} onRetry={shelf.retry} />;
  }
  // Only the first read blanks the shelf; appending a page keeps it in place.
  if (shelf.loading && shelf.items.length === 0) {
    return (
      <ActivityIndicator
        testID="voice-drafts-loading"
        color={accent.primary}
        style={styles.loading}
      />
    );
  }
  if (shelf.settled && shelf.items.length === 0) return <EmptyShelf />;
  return (
    <View>
      {shelf.items.map((item) => (
        <DraftCard key={item.marginalia_id} item={item} onOpen={onOpen} />
      ))}
      {shelf.error !== null ? (
        <ShelfError message={shelf.error} onRetry={shelf.retry} />
      ) : shelf.hasMore ? (
        <TouchableOpacity
          testID="voice-drafts-load-more"
          accessibilityRole="button"
          onPress={shelf.loadMore}
          style={styles.actionRow}
        >
          <Text style={styles.actionText}>{LOAD_MORE_LABEL}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const VoiceDraftsShelfScreen = (): React.JSX.Element => {
  const navigation = useNavigation<ShelfNavigation>();
  const shelf = useVoiceDraftShelf();
  const [open, setOpen] = useState<VoiceDraft | null>(null);

  const close = useCallback(() => setOpen(null), []);
  const openPage = useCallback(
    (draft: VoiceDraft) => {
      // Close first: the shelf should not be waiting behind a letter when the
      // writer comes back from the page.
      setOpen(null);
      navigation.navigate('JournalEntry', { entryId: draft.journal_entry_id });
    },
    [navigation],
  );

  return (
    <ScreenScaffold scroll testID="voice-drafts-shelf">
      <ScreenHeader eyebrow={SCREEN_EYEBROW} title={SCREEN_TITLE} lead={SCREEN_LEAD} />
      <ShelfBody shelf={shelf} onOpen={setOpen} />
      <LetterCard draft={open} onClose={close} onOpenPage={openPage} />
    </ScreenScaffold>
  );
};

export default VoiceDraftsShelfScreen;
