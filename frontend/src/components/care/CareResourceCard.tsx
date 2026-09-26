/**
 * ``CareResourceCard`` — one support pointer: a name, how to reach it, and what
 * it is. Extracted from ``CareSupportNote`` (issue #891) so the same card can be
 * reused both on the reactive journal care surface and the always-available
 * Support & care settings screen, with one shared a11y formula and one set of
 * styles. Purely presentational: it takes a ``CareResource`` and renders text —
 * no chatbot chrome (no sender, avatar, reply, Send), tokens only.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CareResource } from '@/api';
import { SPACING, accent, editorialType, ink, spacing, surface } from '@/design/tokens';

/** Accessibility label combining a resource's name, contact, and description. */
export function resourceLabel(resource: CareResource): string {
  return `${resource.name}. ${resource.contact}. ${resource.what_it_is}`;
}

/** Joins the name and the contact on the compact row. */
export const COMPACT_SEPARATOR = ' · ';

export interface CareResourceCardProps {
  /** The support pointer to render. */
  resource: CareResource;
  /**
   * The journal care note's tighter row (#2862): name and contact share one
   * line that wraps rather than truncates, with what the resource is beneath.
   * Nothing is dropped — only the name/contact line break goes. Settings keeps
   * the default three-line card.
   */
  compact?: boolean;
}

/** One support pointer: name, how to reach it, and what it is. */
function CareResourceCard({ resource, compact = false }: CareResourceCardProps): React.JSX.Element {
  return (
    <View
      style={styles.resource}
      testID={`care-resource-${resource.kind}`}
      accessible
      accessibilityLabel={resourceLabel(resource)}
    >
      {compact ? (
        <Text style={styles.resourceName}>
          {resource.name}
          {COMPACT_SEPARATOR}
          <Text style={styles.compactContact}>{resource.contact}</Text>
        </Text>
      ) : (
        <>
          <Text style={styles.resourceName}>{resource.name}</Text>
          <Text style={styles.resourceContact}>{resource.contact}</Text>
        </>
      )}
      <Text style={styles.resourceWhat}>{resource.what_it_is}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  compactContact: {
    color: accent.strong,
    fontWeight: '400',
  },
  resourceWhat: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: spacing(0.25),
  },
});

export default CareResourceCard;
