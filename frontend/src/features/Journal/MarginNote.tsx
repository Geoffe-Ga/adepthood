/**
 * ``MarginNote`` — one of the AI's margin notes, pinned beside the passage it
 * refers to. Presentational: a serif card with a kind pin (in the kind accent),
 * the note text, and a subtle open affordance. Stale notes render dimmed and
 * show a caption noting the passage has changed. Tapping signals ``onOpen``.
 * A caption under the note says which side answered it, as the server recorded
 * it (#3062) -- "Source not recorded" when it did not.
 */
import React from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { usePressScale } from './motion';
import { paperMarginCard } from './noteCards';
import { sourceLabel } from './sourceLabel';
import { STALE_OPACITY } from './staleTreatment';

import type { Marginalia } from '@/api';
import { colors, editorialType, spacing } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface MarginNoteProps {
  note: Marginalia;
  onOpen: (_note: Marginalia) => void;
}

function MarginNote({ note, onOpen }: MarginNoteProps): React.JSX.Element {
  const isStale = note.status === 'stale';
  const press = usePressScale(useReducedMotion());
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <TouchableOpacity
        style={[
          styles.card,
          { borderLeftColor: colors.marginalia[note.kind] },
          isStale && styles.cardStale,
        ]}
        onPress={() => onOpen(note)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={`Open ${note.kind} note`}
        testID={`margin-note-${note.id}`}
      >
        <Text style={[styles.kind, { color: colors.marginalia[note.kind] }]}>{note.kind}</Text>
        <Text style={styles.note}>{note.note}</Text>
        {isStale ? (
          <Text style={styles.staleCaption} testID={`margin-note-stale-${note.id}`}>
            The passage this noted has changed.
          </Text>
        ) : null}
        <Text style={styles.sourceCaption} testID={`margin-note-source-${note.id}`}>
          {sourceLabel(note.source)}
        </Text>
        <Text style={styles.open}>Open</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // default hairline stripe; overridden per kind inline at the callsite
  card: paperMarginCard(colors.paper.hairline),
  cardStale: {
    opacity: STALE_OPACITY,
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
  staleCaption: {
    ...editorialType.caption,
    fontStyle: 'italic',
    color: colors.paper.inkSoft,
    paddingTop: spacing(0.5),
  },
  sourceCaption: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(0.5),
  },
  open: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
});

export default MarginNote;
