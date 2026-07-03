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
import { StyleSheet, Text, View } from 'react-native';

import { reflectionCardStyles } from './noteCards';
import ReflectionDismiss from './ReflectionDismiss';

import type { ContractionReflection, ContractionVariant } from '@/api';
import { editorialType, ink } from '@/design/tokens';

/** Warm, declinable titles per contraction variant — never punishing copy. */
const VARIANT_TITLES: Record<ContractionVariant, string> = {
  simple_ease_off: 'Tend your foundation',
  return_offer: 'The Return is open to you',
};

const DISMISS_LABEL = 'Not now';
const DISMISS_A11Y = 'Set this reflection aside';

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
    <View style={reflectionCardStyles.root} testID="contraction-reflection">
      <Text
        style={reflectionCardStyles.header}
        accessibilityRole="header"
        testID="contraction-reflection-title"
      >
        {VARIANT_TITLES[contraction.variant]}
      </Text>
      <Text style={styles.message}>{contraction.message}</Text>
      <ReflectionDismiss
        label={DISMISS_LABEL}
        accessibilityLabel={DISMISS_A11Y}
        testID="contraction-dismiss"
        onPress={() => setDismissedFor(contraction)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    ...editorialType.body,
    color: ink.primary,
  },
});

export default ContractionReflectionNote;
