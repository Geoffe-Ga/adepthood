/**
 * ``InvitationNote`` — a quiet paper card that offers one declinable invitation
 * (NORTH-STAR §6). Course invitations cite current writing and open a specific chapter; the corner
 * decline stays independently reachable. Reduced-motion-safe; tokens only.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { invitationCopy } from './invitationCopy';

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

/** Both destinations retain server-validated identities rather than generated URLs. */
function ReadingSuggestion({ invitation }: { invitation: Invitation }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const reading = invitation.reading;
  if (!reading) return null;
  return (
    <View>
      <Text style={styles.line} testID={`invitation-${invitation.id}-line`}>
        {reading.reason}
      </Text>
      <Text style={styles.quote}>“{reading.quote}”</Text>
      <TouchableOpacity
        style={styles.openReading}
        accessibilityRole="button"
        testID={`invitation-${invitation.id}-source`}
        onPress={() => navigation.navigate('JournalEntry', { entryId: reading.entry_id })}
      >
        <Text style={styles.openReadingLabel}>
          From {reading.entry_title || 'your journal entry'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.openReading}
        accessibilityRole="button"
        testID={`invitation-${invitation.id}-open`}
        onPress={() =>
          navigation.navigate('Tabs', {
            screen: 'Course',
            params: {
              stageNumber: reading.stage_number,
              contentId: reading.content_id,
              openReading: true,
            },
          })
        }
      >
        <Text style={styles.openReadingLabel}>{reading.title}</Text>
      </TouchableOpacity>
      <Text style={styles.line}>{reading.benefit}</Text>
    </View>
  );
}

function InvitationNote({ invitation, onDismiss }: InvitationNoteProps): React.JSX.Element | null {
  const copy = invitationCopy(invitation.target_type, invitation.kind);
  if (invitation.target_type === 'course' && !invitation.reading) return null;
  return (
    <View style={styles.card} testID={`invitation-${invitation.id}`}>
      {invitation.target_type === 'course' ? (
        <ReadingSuggestion invitation={invitation} />
      ) : (
        <Text style={styles.line} testID={`invitation-${invitation.id}-line`}>
          {copy.line}
        </Text>
      )}
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
  quote: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
    marginRight: closeCornerReserve(SPACING.md),
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
