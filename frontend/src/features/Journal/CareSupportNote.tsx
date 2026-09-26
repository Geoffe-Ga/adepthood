/**
 * ``CareSupportNote`` — the human + professional support surface shown when a
 * resonance pass screens an entry as carrying an acute-distress signal
 * (NORTH-STAR §10). It *accompanies* the reflection — it never replaces it — so a
 * distressed person is pointed at people (988, Crisis Text Line, someone they
 * trust) and clinical care rather than left alone with AI-generated text.
 *
 * Deliberately NOT a chatbot: there is no avatar, no sender, no reply, no Send.
 * It is a warm, non-shaming card — a short header-role title, the message as
 * body text, and the ordered resources, crisis lines first (#2862).
 *
 * The X in the corner removes the whole card, but never the way back to help:
 * one "Support options" line stays in its place and restores the card in a tap,
 * and Settings → Support & care carries the same resources permanently. The
 * dismissal is held in memory only, keyed by the care object's identity, so it
 * is never persisted and a fresh distress signal always re-surfaces the card.
 * Presentational, reduced-motion-safe, tokens only.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { reflectionCardStyles } from './noteCards';
import ReflectionDismiss from './ReflectionDismiss';

import type { CareResponse } from '@/api';
import CareResourceCard from '@/components/care/CareResourceCard';
import { SPACING, editorialType } from '@/design/tokens';

const CLOSE_A11Y = 'Hide the support note';
const REOPEN_LABEL = 'Support options';
const REOPEN_A11Y = 'Show the support options again';

export interface CareSupportNoteProps {
  /** The care surface from the latest resonance pass; ``null`` hides everything. */
  care: CareResponse | null;
}

/** The dismissed state: one chrome-free line that restores the whole card. */
function ReopenLine({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <View style={styles.reopenLine}>
      <ReflectionDismiss
        variant="reopen"
        label={REOPEN_LABEL}
        accessibilityLabel={REOPEN_A11Y}
        testID="care-reopen"
        onPress={onPress}
        textStyle={styles.reopenText}
      />
    </View>
  );
}

/**
 * The card: title, message, the resources in server order, then the X. The X
 * is last in the tree so a screen reader meets the help before the way to hide
 * it; it is drawn in the top-right corner by absolute placement.
 */
function CareCard({
  care,
  onClose,
}: {
  care: CareResponse;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <View style={reflectionCardStyles.root} testID="care-support-card">
      <Text style={reflectionCardStyles.heading} accessibilityRole="header">
        {care.title}
      </Text>
      <Text style={reflectionCardStyles.careBody}>{care.message}</Text>
      {care.resources.map((resource) => (
        <CareResourceCard key={resource.kind} resource={resource} compact />
      ))}
      <ReflectionDismiss
        variant="close"
        accessibilityLabel={CLOSE_A11Y}
        testID="care-dismiss"
        onPress={onClose}
      />
    </View>
  );
}

function CareSupportNote({ care }: CareSupportNoteProps): React.JSX.Element | null {
  // Reference-identity collapse: a fresh care object never matches the pinned one, so a new crisis signal always re-surfaces the card.
  const [collapsedFor, setCollapsedFor] = useState<CareResponse | null>(null);
  if (care == null) return null;
  const expanded = collapsedFor !== care;
  return (
    <View testID="care-support">
      {expanded ? (
        <CareCard care={care} onClose={() => setCollapsedFor(care)} />
      ) : (
        <ReopenLine onPress={() => setCollapsedFor(null)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  reopenLine: {
    marginHorizontal: SPACING.lg,
  },
  reopenText: {
    ...editorialType.action,
  },
});

export default CareSupportNote;
