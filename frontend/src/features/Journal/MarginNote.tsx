/**
 * ``MarginNote`` — one of the AI's margin notes, pinned beside the passage it
 * refers to. Presentational: a serif card with a kind pin (in the kind accent),
 * the note text, and a subtle open affordance. Stale notes render dimmed (full
 * staleness styling lands in a later issue). Tapping signals ``onOpen``.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import type { Marginalia } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';

export interface MarginNoteProps {
  note: Marginalia;
  onOpen: (_note: Marginalia) => void;
}

function MarginNote({ note, onOpen }: MarginNoteProps): React.JSX.Element {
  const isStale = note.status === 'stale';
  return (
    <TouchableOpacity
      style={[styles.card, isStale && styles.cardStale]}
      onPress={() => onOpen(note)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${note.kind} note`}
      testID={`margin-note-${note.id}`}
    >
      <Text style={[styles.kind, { color: colors.marginalia[note.kind] }]}>{note.kind}</Text>
      <Text style={styles.note}>{note.note}</Text>
      <Text style={styles.open}>{isStale ? 'Anchor moved · Open' : 'Open'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.backgroundAlt,
    borderLeftWidth: 3,
    borderLeftColor: colors.paper.hairline,
  },
  cardStale: {
    opacity: 0.55,
  },
  kind: {
    ...editorialType.caption,
    textTransform: 'capitalize',
    fontWeight: '600',
  },
  note: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    paddingTop: spacing(0.5),
  },
  open: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
});

export default MarginNote;
