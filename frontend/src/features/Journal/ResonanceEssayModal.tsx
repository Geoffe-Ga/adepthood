/**
 * ``ResonanceEssayModal`` — a margin note expanded into its letter-like essay,
 * hovering over the (still-visible, dimmed) page. Lazily fetches the essay the
 * first time a note is opened and caches it back to the note via
 * ``onEssayLoaded`` so re-opening is instant. A warm editorial reading card, not
 * a chat reply.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import JournalModalShell from './JournalModalShell';

import { resonance } from '@/api';
import type { Marginalia } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { colors, editorialType, spacing, touchTarget } from '@/design/tokens';

export interface ResonanceEssayModalProps {
  note: Marginalia | null;
  onClose: () => void;
  onEssayLoaded?: (_note: Marginalia) => void;
}

/** Shown when a fetch resolves an empty essay, so the user isn't stranded on a blank card. */
const BLANK_ESSAY_MESSAGE = "This note's essay isn't ready yet.";

interface EssayState {
  essay: string | null;
  loading: boolean;
  error: string | null;
}

/** Lazily load the note's essay (unless it already carries one). */
function useEssay(
  note: Marginalia | null,
  onEssayLoaded?: (_n: Marginalia) => void,
): EssayState & {
  retry: () => void;
} {
  const [state, setState] = useState<EssayState>({ essay: null, loading: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // Hold the callback in a ref so a non-memoised caller can't retrigger fetches:
  // the fetch effect depends only on the note + retry attempt.
  const onLoadedRef = useRef(onEssayLoaded);
  useEffect(() => {
    onLoadedRef.current = onEssayLoaded;
  }, [onEssayLoaded]);

  useEffect(() => {
    if (note == null) return undefined;
    if (note.essay) {
      // Treat a blank essay the same as missing (don't render an empty body).
      setState({ essay: note.essay, loading: false, error: null });
      return undefined;
    }
    let active = true;
    setState({ essay: null, loading: true, error: null });
    resonance
      .essay(note.id)
      .then((updated) => {
        if (!active) return;
        if (updated.essay) {
          // Same blank-as-missing contract as the cached path above.
          setState({ essay: updated.essay, loading: false, error: null });
          onLoadedRef.current?.(updated);
          return;
        }
        // Don't cache a blank essay back (it would re-fetch on every reopen).
        setState({ essay: null, loading: false, error: BLANK_ESSAY_MESSAGE });
      })
      .catch((err: unknown) => {
        if (active) setState({ essay: null, loading: false, error: formatApiError(err) });
      });
    return () => {
      active = false;
    };
  }, [note, attempt]);

  return { ...state, retry };
}

/** The body region: spinner, the essay, or a friendly error with retry. */
function EssayBody({ essay, loading, error, retry }: EssayState & { retry: () => void }) {
  if (loading) {
    return <ActivityIndicator testID="essay-loading" color={colors.paper.ink} />;
  }
  if (error != null) {
    return (
      <TouchableOpacity onPress={retry} accessibilityRole="button" testID="essay-retry">
        <Text style={styles.error}>{error}</Text>
        <Text style={styles.retry}>Tap to try again</Text>
      </TouchableOpacity>
    );
  }
  return (
    <Text style={styles.essay} testID="essay-text">
      {essay}
    </Text>
  );
}

function ResonanceEssayModal({
  note,
  onClose,
  onEssayLoaded,
}: ResonanceEssayModalProps): React.JSX.Element {
  const { essay, loading, error, retry } = useEssay(note, onEssayLoaded);

  return (
    <JournalModalShell
      visible={note != null}
      onDismiss={onClose}
      scrimTestID="essay-scrim"
      scrimLabel="Dismiss essay"
      modalTestID="essay-modal"
      cardStyle={styles.essayCard}
    >
      <View style={styles.header}>
        <Text style={[styles.kind, { color: note ? colors.marginalia[note.kind] : undefined }]}>
          {note?.kind}
        </Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID="essay-close"
        >
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.quote} testID="essay-quote">
        “{note?.anchor_text}”
      </Text>
      <ScrollView contentContainerStyle={styles.bodyScroll}>
        <EssayBody essay={essay} loading={loading} error={error} retry={retry} />
      </ScrollView>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  essayCard: {
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  kind: {
    ...editorialType.caption,
    textTransform: 'capitalize',
    fontWeight: '600',
  },
  close: {
    fontSize: 28,
    lineHeight: 28,
    minWidth: touchTarget.minimum,
    textAlign: 'right',
    color: colors.paper.inkSoft,
  },
  quote: {
    ...editorialType.title,
    color: colors.paper.ink,
    paddingVertical: spacing(1.5),
  },
  bodyScroll: {
    paddingTop: spacing(1),
  },
  essay: {
    ...editorialType.body,
    color: colors.paper.ink,
  },
  error: {
    ...editorialType.body,
    color: colors.danger,
  },
  retry: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
});

export default ResonanceEssayModal;
