import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SessionSurface } from '../sessionSurface';

import { SessionCtaButton } from './SessionCtaButton';

import { BORDER_RADIUS, SPACING, shadows } from '@/design/tokens';

interface GroundingCompleteCardProps {
  /** Copy describing what the user just finished, e.g. "You tallied every round." */
  body: string;
  /** Root testID, e.g. `sense-grounding-complete`. */
  testID: string;
  /** Save-button testID, e.g. `sense-grounding-save`. */
  saveTestID: string;
  onSave?: () => void;
  surface: SessionSurface;
}

/** Completion summary + Save CTA shared by the grounding rituals. */
export const GroundingCompleteCard = ({
  body,
  testID,
  saveTestID,
  onSave,
  surface,
}: GroundingCompleteCardProps): React.JSX.Element => (
  <View style={[styles.completeCard, { backgroundColor: surface.raised }]} testID={testID}>
    <Text style={[styles.completeTitle, { color: surface.accent }]}>Grounding complete</Text>
    <Text style={[styles.completeBody, { color: surface.textSoft }]}>{body}</Text>
    <SessionCtaButton
      variant="success"
      label="Save session"
      accessibilityLabel="Save session and reflect"
      disabled={!onSave}
      onPress={onSave}
      testID={saveTestID}
      accessibilityState={{ disabled: !onSave }}
    />
  </View>
);

/** Header layout + badge type shared by the grounding ritual headers. */
export const groundingHeaderStyles = StyleSheet.create({
  header: { alignItems: 'center', marginBottom: SPACING.xl },
  badge: {
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: SPACING.sm,
  },
});

const styles = StyleSheet.create({
  completeCard: {
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    alignItems: 'center',
    marginBottom: SPACING.xl,
    maxWidth: 320,
    ...shadows.small,
  },
  completeTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: SPACING.sm,
  },
  completeBody: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
});
