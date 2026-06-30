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
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  paperShadow,
  spacing,
  surface,
  touchTarget,
} from '@/design/tokens';

const DISMISS_LABEL = 'Dismiss';
const REOPEN_LABEL = 'Show support options';
const DISMISS_A11Y = 'Hide the support options';
const REOPEN_A11Y = 'Show the support options again';

/** Accessibility label combining a resource's name, contact, and description. */
function resourceLabel(resource: CareResource): string {
  return `${resource.name}. ${resource.contact}. ${resource.what_it_is}`;
}

export interface CareSupportNoteProps {
  /** The care surface from the latest resonance pass; ``null`` hides everything. */
  care: CareResponse | null;
}

/** One support pointer: name, how to reach it, and what it is. */
function ResourceCard({ resource }: { resource: CareResource }): React.JSX.Element {
  return (
    <View
      style={styles.resource}
      testID={`care-resource-${resource.kind}`}
      accessible
      accessibilityLabel={resourceLabel(resource)}
    >
      <Text style={styles.resourceName}>{resource.name}</Text>
      <Text style={styles.resourceContact}>{resource.contact}</Text>
      <Text style={styles.resourceWhat}>{resource.what_it_is}</Text>
    </View>
  );
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
        <ResourceCard key={resource.kind} resource={resource} />
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
  resource: {
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: surface.hairline,
  },
  resourceName: {
    ...editorialType.note,
    fontWeight: '600',
    color: ink.primary,
  },
  resourceContact: {
    ...editorialType.note,
    color: accent.strong,
    marginTop: spacing(0.25),
  },
  resourceWhat: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: spacing(0.25),
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
