/**
 * ``InvitationNote`` — a quiet paper card that offers one declinable invitation
 * (NORTH-STAR §6). Course invitations open the offered section; the corner
 * decline stays independently reachable. Reduced-motion-safe; tokens only.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { invitationCopy } from './invitationCopy';
import { useInvitationAspect } from './useInvitationAspect';

import type { Invitation } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import ReflectionDismiss, { closeCornerReserve } from '@/features/Journal/ReflectionDismiss';
import type { RootStackParamList } from '@/navigation/RootStack';

export interface InvitationNoteProps {
  invitation: Invitation;
  onDismiss: (_id: number) => void | Promise<void>;
}

/** The signal names a course stage, so keep that coordinate through navigation. */
function CourseReadingLink({ stageNumber, id }: { stageNumber: number; id: number }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <TouchableOpacity
      style={styles.openReading}
      accessibilityRole="button"
      testID={`invitation-${id}-open`}
      onPress={() =>
        navigation.navigate('Tabs', {
          screen: 'Course',
          params: { stageNumber, openSection: true },
        })
      }
    >
      <Text style={styles.openReadingLabel}>View reading</Text>
    </TouchableOpacity>
  );
}

function InvitationNote({ invitation, onDismiss }: InvitationNoteProps): React.JSX.Element {
  const aspect = useInvitationAspect(invitation);
  const copy = invitationCopy(invitation.target_type, invitation.kind, { aspect });
  return (
    <View style={styles.card} testID={`invitation-${invitation.id}`}>
      <Text style={styles.line} testID={`invitation-${invitation.id}-line`}>
        {copy.line}
      </Text>
      {invitation.target_type === 'course' && invitation.target_id !== null ? (
        <CourseReadingLink stageNumber={invitation.target_id} id={invitation.id} />
      ) : null}
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
  openReading: {
    alignSelf: 'flex-start',
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    maxWidth: '100%',
    justifyContent: 'center',
    marginTop: spacing(1),
    paddingVertical: spacing(1),
  },
  openReadingLabel: {
    ...editorialType.action,
    color: accent.primary,
    flexShrink: 1,
  },
});

export default InvitationNote;
