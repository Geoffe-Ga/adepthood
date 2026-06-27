/**
 * ``ResonanceEssayModal`` — a margin note expanded into its letter-like essay,
 * hovering over the (still-visible, dimmed) page. Lazily fetches the essay the
 * first time a note is opened and caches it back to the note via
 * ``onEssayLoaded`` so re-opening is instant. A warm editorial reading card, not
 * a chat reply.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { resonance } from '@/api';
import type { Marginalia } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';

export interface ResonanceEssayModalProps {
  note: Marginalia | null;
  onClose: () => void;
  onEssayLoaded?: (_note: Marginalia) => void;
}

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

  useEffect(() => {
    if (note == null) return undefined;
    if (note.essay != null) {
      setState({ essay: note.essay, loading: false, error: null });
      return undefined;
    }
    let active = true;
    setState({ essay: null, loading: true, error: null });
    resonance
      .essay(note.id)
      .then((updated) => {
        if (!active) return;
        setState({ essay: updated.essay, loading: false, error: null });
        onEssayLoaded?.(updated);
      })
      .catch((err: unknown) => {
        if (active) setState({ essay: null, loading: false, error: formatApiError(err) });
      });
    return () => {
      active = false;
    };
  }, [note, attempt, onEssayLoaded]);

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
    <Modal
      visible={note != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="essay-modal"
    >
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        testID="essay-scrim"
        accessibilityLabel="Dismiss essay"
      >
        {/* Stop taps on the card from dismissing. */}
        <Pressable style={styles.card} onPress={() => {}}>
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  card: {
    maxHeight: '80%',
    padding: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: colors.paper.background,
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
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
});

export default ResonanceEssayModal;
