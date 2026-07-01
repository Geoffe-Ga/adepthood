/**
 * ``InvitationNote`` — a quiet paper card that offers one declinable invitation
 * (NORTH-STAR §6). It renders the derived microcopy line plus a single decline
 * affordance; there is no accept action, because the invitation is the offer.
 * Presentational + reduced-motion-safe; tokens only.
 */
import React from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { invitationCopy } from './invitationCopy';

import type { Invitation } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { usePressScale } from '@/hooks/usePressScale';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const DECLINE_LABEL = 'Not now';

export interface InvitationNoteProps {
  invitation: Invitation;
  onDismiss: (_id: number) => void | Promise<void>;
}

/** The single decline affordance: a ≥44dp button with a non-shaming a11y label. */
function DeclineButton({
  id,
  label,
  onDismiss,
  onPressIn,
  onPressOut,
}: {
  id: number;
  label: string;
  onDismiss: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.decline}
      onPress={onDismiss}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`invitation-${id}-dismiss`}
    >
      <Text style={styles.declineText}>{DECLINE_LABEL}</Text>
    </TouchableOpacity>
  );
}

function InvitationNote({ invitation, onDismiss }: InvitationNoteProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const copy = invitationCopy(invitation.target_type, invitation.kind);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID={`invitation-${invitation.id}`}>
        <Text style={styles.line}>{copy.line}</Text>
        <DeclineButton
          id={invitation.id}
          label={copy.declineA11y}
          onDismiss={() => onDismiss(invitation.id)}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.clear,
    ...paperShadow.card,
  },
  line: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
  },
  decline: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginTop: spacing(1),
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineText: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
});

export default InvitationNote;
