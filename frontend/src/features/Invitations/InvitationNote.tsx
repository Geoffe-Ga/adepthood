/**
 * ``InvitationNote`` — a quiet paper card that offers one declinable invitation
 * (NORTH-STAR §6). It renders the derived microcopy line plus a single decline
 * affordance; there is no accept action, because the invitation is the offer.
 * Presentational + reduced-motion-safe; tokens only.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { invitationCopy } from './invitationCopy';
import { useInvitationAspect } from './useInvitationAspect';

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
import ReflectionDismiss, { closeCornerReserve } from '@/features/Journal/ReflectionDismiss';

export interface InvitationNoteProps {
  invitation: Invitation;
  onDismiss: (_id: number) => void | Promise<void>;
}

function InvitationNote({ invitation, onDismiss }: InvitationNoteProps): React.JSX.Element {
  const aspect = useInvitationAspect(invitation);
  const copy = invitationCopy(invitation.target_type, invitation.kind, { aspect });
  return (
    <View style={styles.card} testID={`invitation-${invitation.id}`}>
      <Text style={styles.line} testID={`invitation-${invitation.id}-line`}>
        {copy.line}
      </Text>
      <ReflectionDismiss
        variant="close"
        testID={`invitation-${invitation.id}-dismiss`}
        accessibilityLabel={copy.declineA11y}
        onPress={() => {
          void Promise.resolve(onDismiss(invitation.id)).catch(() => {
            // The hook restores the failed row; keep rejection inside the tap handler.
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    marginTop: spacing(1),
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.clear,
    ...paperShadow.card,
  },
  line: {
    ...editorialType.marginNote,
    marginRight: closeCornerReserve(SPACING.md),
    color: colors.paper.ink,
  },
});

export default InvitationNote;
