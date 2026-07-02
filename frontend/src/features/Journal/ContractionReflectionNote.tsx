/**
 * ``ContractionReflectionNote`` — a warm, declinable "tend your foundation"
 * reflection shown when a resonance pass senses a foundation easing off. It
 * mirrors ``CareSupportNote`` in shape but is deliberately gentler: it names a
 * gentle nudge (``simple_ease_off``) or an open invitation (``return_offer``),
 * never failure, demotion, or ranking. "You choose your depth" — a single tap
 * sets it aside for good, and only a fresh pass's new reflection resurfaces it.
 *
 * Deliberately NOT a chatbot: no avatar, no sender, no reply, no Send. It is a
 * header-role title, the backend's own message, and a one-tap dismiss.
 * Presentational, reduced-motion-safe, tokens only.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { ContractionReflection, ContractionVariant } from '@/api';
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

/** Warm, declinable titles per contraction variant — never punishing copy. */
const VARIANT_TITLES: Record<ContractionVariant, string> = {
  simple_ease_off: 'Tend your foundation',
  return_offer: 'The Return is open to you',
};

const DISMISS_LABEL = 'Not now';
const DISMISS_A11Y = 'Set this reflection aside';
/** The warm accent stripe width; matches the care surface's foundation cue. */
const ACCENT_STRIPE_WIDTH = 4;

export interface ContractionReflectionNoteProps {
  /** The contraction surface from the latest pass; ``null`` hides everything. */
  contraction: ContractionReflection | null;
}

function ContractionReflectionNote({
  contraction,
}: ContractionReflectionNoteProps): React.JSX.Element | null {
  // Reference-identity dismissal: setting ``dismissedFor`` to the current object
  // hides it for good, but a fresh pass hands a NEW object that never matches —
  // so a later reflection resurfaces without a re-open affordance.
  const [dismissedFor, setDismissedFor] = useState<ContractionReflection | null>(null);
  if (contraction == null || dismissedFor === contraction) return null;
  return (
    <View style={styles.root} testID="contraction-reflection">
      <Text style={styles.title} accessibilityRole="header" testID="contraction-reflection-title">
        {VARIANT_TITLES[contraction.variant]}
      </Text>
      <Text style={styles.message}>{contraction.message}</Text>
      <TouchableOpacity
        style={styles.dismiss}
        onPress={() => setDismissedFor(contraction)}
        accessibilityRole="button"
        accessibilityLabel={DISMISS_A11Y}
        testID="contraction-dismiss"
      >
        <Text style={styles.dismissText}>{DISMISS_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    margin: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_STRIPE_WIDTH,
    borderLeftColor: accent.primary,
    ...paperShadow.card,
  },
  title: {
    ...editorialType.title,
    color: ink.primary,
    marginBottom: SPACING.md,
  },
  message: {
    ...editorialType.body,
    color: ink.primary,
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
});

export default ContractionReflectionNote;
