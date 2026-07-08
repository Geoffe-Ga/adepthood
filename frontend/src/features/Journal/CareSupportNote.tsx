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
 * (mirrors ``ContractionReflectionNote``).
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { reflectionCardStyles } from './noteCards';
import ReflectionDismiss from './ReflectionDismiss';

import type { CareResource, CareResponse } from '@/api';
import CareResourceCard from '@/components/care/CareResourceCard';
import { SPACING, accent, editorialType, touchTarget } from '@/design/tokens';

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
      <ReflectionDismiss
        label={DISMISS_LABEL}
        accessibilityLabel={DISMISS_A11Y}
        testID="care-dismiss"
        onPress={onDismiss}
      />
    </>
  );
}

function CareSupportNote({ care }: CareSupportNoteProps): React.JSX.Element | null {
  // Reference-identity collapse: a fresh care object never matches the pinned one, so a new crisis signal always re-surfaces the resources.
  const [collapsedFor, setCollapsedFor] = useState<CareResponse | null>(null);
  if (care == null) return null;
  const expanded = collapsedFor !== care;
  return (
    <View style={reflectionCardStyles.root} testID="care-support">
      <Text style={reflectionCardStyles.header} accessibilityRole="header">
        {care.message}
      </Text>
      {expanded ? (
        <ExpandedBody resources={care.resources} onDismiss={() => setCollapsedFor(care)} />
      ) : (
        <ReopenControl onPress={() => setCollapsedFor(null)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
