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

/**
 * Why an ask for a note's letter settled without one, keyed by note id.
 *
 * The server deliberately leaves ``essay`` NULL when it refuses a completion as
 * not-a-letter, and when the entry is intimate, so the writer can ask again
 * (``backend/src/routers/journal.py::_cache_essay``). That is precisely why the
 * note itself cannot record "already asked" — so the fact is remembered here
 * instead, and only for as long as this screen is mounted.
 */
type UnansweredNotes = Map<number, string>;

/**
 * The state a note can be shown from without asking the server, or ``null``
 * when it must be asked for: its own cached letter, else a remembered ask that
 * produced none. A blank cached essay counts as missing, so an empty body is
 * never rendered.
 */
function settledState(note: Marginalia, unanswered: UnansweredNotes): EssayState | null {
  if (note.essay) return { essay: note.essay, loading: false, error: null };
  const remembered = unanswered.get(note.id);
  if (remembered !== undefined) return { essay: null, loading: false, error: remembered };
  return null;
}

/** The two ways an ask settles, handed to {@link askForEssay} by the hook. */
interface EssaySettlers {
  /** A real letter arrived, and should be cached back onto the note. */
  onLetter: (_updated: Marginalia) => void;
  /** The ask produced no letter: a refusal, an intimate entry, or a failure. */
  onUnanswered: (_message: string) => void;
}

/** Ask the server for one note's letter and route the outcome to ``settlers``. */
function askForEssay(noteId: number, settlers: EssaySettlers): void {
  resonance
    .essay(noteId)
    .then((updated) => {
      if (updated.essay) {
        settlers.onLetter(updated);
        return;
      }
      settlers.onUnanswered(BLANK_ESSAY_MESSAGE);
    })
    .catch((err: unknown) => settlers.onUnanswered(formatApiError(err)));
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
  // Notes already asked about, that came back with no letter (#2435). A ref, so
  // it survives closing and reopening the modal and dies with the screen: an
  // automatic re-ask on every reopen is what this stops, while leaving a
  // refusal — which is transient — askable again both on purpose (``retry``)
  // and on a later visit.
  const unansweredRef = useRef<UnansweredNotes>(new Map());
  const retry = useCallback(() => {
    // The deliberate ask: forget the remembered outcome first, or the effect
    // below would answer from memory instead of the server.
    if (note != null) unansweredRef.current.delete(note.id);
    setAttempt((a) => a + 1);
  }, [note]);
  // Hold the callback in a ref so a non-memoised caller can't retrigger fetches:
  // the fetch effect depends only on the note + retry attempt.
  const onLoadedRef = useRef(onEssayLoaded);
  useEffect(() => {
    onLoadedRef.current = onEssayLoaded;
  }, [onEssayLoaded]);

  useEffect(() => {
    if (note == null) return undefined;
    // Already answered — by the note's own letter, or by an earlier ask for this
    // note that produced none. Say so again rather than asking the server the
    // same question every time the note is reopened (#2435).
    const settled = settledState(note, unansweredRef.current);
    if (settled !== null) {
      setState(settled);
      return undefined;
    }
    let active = true;
    setState({ essay: null, loading: true, error: null });
    askForEssay(note.id, {
      onLetter: (updated) => {
        if (!active) return;
        // The note carries the letter from here on, via ``onEssayLoaded``.
        setState({ essay: updated.essay, loading: false, error: null });
        onLoadedRef.current?.(updated);
      },
      // Remembered even if the modal has since closed: the ask did happen and
      // produced nothing, so reopening should show that, not ask again.
      onUnanswered: (message) => {
        unansweredRef.current.set(note.id, message);
        if (active) setState({ essay: null, loading: false, error: message });
      },
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
