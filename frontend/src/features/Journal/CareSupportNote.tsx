/**
 * ``CareSupportNote`` — the human + professional support surface shown when a
 * resonance pass screens an entry as carrying an acute-distress signal
 * (NORTH-STAR §10). It *accompanies* the reflection — it never replaces it — so a
 * distressed person is pointed at people (988, Crisis Text Line, someone they
 * trust) and clinical care rather than left alone with AI-generated text.
 *
 * Deliberately NOT a chatbot: there is no avatar, no sender, no reply, no Send.
 * It is a warm, non-shaming panel — a header-role message plus an ordered list
 * of resources. ``Dismiss`` collapses the list to a persistent ``Re-open``
 * affordance rather than removing the surface entirely, so the user can never
 * lose their way back to help. Presentational, reduced-motion-safe, tokens only
 * (mirrors ``CompletionSuggestionNote``).
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { CareResource, CareResponse } from '@/api';
import CareResourceCard from '@/components/care/CareResourceCard';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  paperShadow,
  surface,
  touchTarget,
} from '@/design/tokens';

const DISMISS_LABEL = 'Dismiss';
const REOPEN_LABEL = 'Show support options';
const DISMISS_A11Y = 'Hide the support options';
const REOPEN_A11Y = 'Show the support options again';

export interface CareSupportNoteProps {
  /** The care surface from the latest resonance pass; ``null`` hides everything. */
  care: CareResponse | null;
}

/** The collapsed state: a single affordance that restores the resource list. */
function ReopenControl({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.reopen}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={REOPEN_A11Y}
      testID="care-reopen"
    >
      <Text style={styles.reopenText}>{REOPEN_LABEL}</Text>
    </TouchableOpacity>
  );
}

/** The expanded state: the ordered resources plus a dismiss affordance. */
function ExpandedBody({
  resources,
  onDismiss,
}: {
  resources: CareResource[];
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <>
      {resources.map((resource) => (
        <CareResourceCard key={resource.kind} resource={resource} />
      ))}
      <TouchableOpacity
        style={styles.dismiss}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={DISMISS_A11Y}
        testID="care-dismiss"
      >
        <Text style={styles.dismissText}>{DISMISS_LABEL}</Text>
      </TouchableOpacity>
    </>
  );
}

function CareSupportNote({ care }: CareSupportNoteProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  if (care == null) return null;
  return (
    <View style={styles.root} testID="care-support">
      <Text style={styles.message} accessibilityRole="header">
        {care.message}
      </Text>
      {expanded ? (
        <ExpandedBody resources={care.resources} onDismiss={() => setExpanded(false)} />
      ) : (
        <ReopenControl onPress={() => setExpanded(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    margin: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
    borderLeftWidth: 4,
    borderLeftColor: accent.primary,
    ...paperShadow.card,
  },
  message: {
    ...editorialType.title,
    color: ink.primary,
    marginBottom: SPACING.md,
  },
  dismiss: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissText: {
    ...editorialType.note,
    fontWeight: '600',
    color: ink.soft,
  },
  reopen: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reopenText: {
    ...editorialType.note,
    fontWeight: '600',
    color: accent.primary,
  },
});

export default CareSupportNote;
