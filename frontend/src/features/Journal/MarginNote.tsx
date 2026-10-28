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
import type { TouchableOpacityProps } from 'react-native';

import InferenceReceiptDetails from './InferenceReceiptDetails';
import { useMarginNavigation } from './marginNavigation';
import { usePressScale } from './motion';
import { PAPER_STRIPE_WIDTH, paperMarginCard } from './noteCards';
import { sourceLabel } from './sourceLabel';
import { STALE_OPACITY } from './staleTreatment';

import type { Marginalia } from '@/api';
import { readNoteReceiptMetadata } from '@/api/schemas';
import { webCurrentState } from '@/components/webAria';
import { SPACING, colors, editorialType, spacing, touchTarget } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface MarginNoteProps {
  note: Marginalia;
  onOpen: (_note: Marginalia) => void;
}

function MarginNote({ note, onOpen }: MarginNoteProps): React.JSX.Element {
  const navigation = useMarginNavigation();
  const selected = navigation?.selectedId === note.id;
  const showPassage = navigation?.canNavigate(note) ?? false;
  const isStale = navigation?.isStale(note) ?? note.status === 'stale';
  const press = usePressScale(useReducedMotion());
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <TouchableOpacity
        style={[
          styles.card,
          { borderLeftColor: colors.marginalia[note.kind] },
          isStale && styles.cardStale,
          selected && styles.cardSelected,
        ]}
        onPress={() => openOrNavigate(note, onOpen, navigation)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={
          showPassage ? `Show passage for ${note.kind} note` : `Open ${note.kind} note`
        }
        accessibilityState={{ selected }}
        {...webCurrentState<TouchableOpacityProps>(selected)}
        testID={`margin-note-${note.id}`}
      >
        <NoteContent note={note} isStale={isStale} showPassage={showPassage} />
      </TouchableOpacity>
      {showPassage ? <OpenNote note={note} onOpen={onOpen} /> : null}
    </Animated.View>
  );
}

function openOrNavigate(
  note: Marginalia,
  open: (_note: Marginalia) => void,
  navigation: ReturnType<typeof useMarginNavigation>,
): void {
  if (navigation == null) {
    open(note);
    return;
  }
  if (!navigation.isCurrent()) return;
  if (!navigation.fromNote(note) && navigation.isCurrent()) open(note);
}

function OpenNote({ note, onOpen }: MarginNoteProps): React.JSX.Element {
  const navigation = useMarginNavigation();
  return (
    <TouchableOpacity
      onPress={() => {
        if (navigation?.isCurrent()) onOpen(note);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Open ${note.kind} note`}
      style={styles.openAction}
      testID={`margin-note-open-${note.id}`}
    >
      <Text style={styles.open}>Open note</Text>
    </TouchableOpacity>
  );
}
function NoteContent({
  note,
  isStale,
  showPassage,
}: {
  note: Marginalia;
  isStale: boolean;
  showPassage: boolean;
}): React.JSX.Element {
  const parsedReceipt = readNoteReceiptMetadata(note);
  const receipt = parsedReceipt.success ? parsedReceipt.data : null;
  return (
    <>
      <Text style={[styles.kind, { color: colors.marginalia[note.kind] }]}>{note.kind}</Text>
      <Text style={styles.note}>{note.note}</Text>
      {isStale ? (
        <Text style={styles.staleCaption} testID={`margin-note-stale-${note.id}`}>
          The passage this noted has changed.
        </Text>
      ) : null}
      <Text style={styles.sourceCaption} testID={`margin-note-source-${note.id}`}>
        {sourceLabel(receipt?.source)}
      </Text>
      {receipt ? (
        <InferenceReceiptDetails
          provider={receipt.source_provider}
          model={receipt.source_model}
          style={styles.sourceCaption}
        />
      ) : null}
      {!showPassage ? (
        <Text style={styles.open}>Open</Text>
      ) : (
        <Text style={styles.open}>Show passage</Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // default hairline stripe; overridden per kind inline at the callsite
  card: paperMarginCard(colors.paper.hairline),
  cardSelected: { backgroundColor: colors.paper.anchorHighlight },
  openAction: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingLeft: SPACING.md + PAPER_STRIPE_WIDTH,
    paddingRight: SPACING.md,
  },
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
