/**
 * ``HeldWordsLeaveDialog`` — asked before leaving a page whose offline words are
 * still waiting to be put back (#2935). Those words live only in this screen
 * until they are saved, so leaving drops them; the page never lets that happen
 * silently. Staying is the default. Where the words wait on a privacy setting
 * that failed to save, trying that save again is offered too.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import JournalModalShell from './JournalModalShell';

import {
  BORDER_RADIUS,
  colors,
  editorialType,
  journalLayout,
  spacing,
  touchTarget,
} from '@/design/tokens';

/** The dialog's heading. */
export const HELD_LEAVE_TITLE = 'Leave your offline words behind?';

/** Why leaving now would lose words, said without blame. */
export const HELD_LEAVE_BODY =
  'The words you wrote while this page couldn’t open haven’t been saved yet. If you leave now, they won’t come with you.';

export const HELD_LEAVE_STAY = 'Stay';
export const HELD_LEAVE_RETRY = 'Try saving again';
export const HELD_LEAVE_LEAVE = 'Leave without them';

export interface HeldWordsLeaveDialogProps {
  visible: boolean;
  onStay: () => void;
  onLeave: () => void;
  /** Offered only when the words wait on a privacy setting that failed to save. */
  onRetry?: () => void;
}

interface ChoiceProps {
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}

function Choice({ label, onPress, testID, primary = false }: ChoiceProps) {
  return (
    <TouchableOpacity
      style={primary ? styles.primary : styles.secondary}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={primary ? styles.primaryLabel : styles.secondaryLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function HeldWordsLeaveDialog({
  visible,
  onStay,
  onLeave,
  onRetry,
}: HeldWordsLeaveDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onStay}
      scrimTestID="held-leave-scrim"
      scrimLabel={HELD_LEAVE_STAY}
      cardTestID="held-leave-dialog"
      cardStyle={styles.card}
    >
      <Text style={styles.title}>{HELD_LEAVE_TITLE}</Text>
      <Text style={styles.body}>{HELD_LEAVE_BODY}</Text>
      <Choice label={HELD_LEAVE_STAY} onPress={onStay} testID="held-leave-stay" primary />
      {onRetry ? (
        <Choice label={HELD_LEAVE_RETRY} onPress={onRetry} testID="held-leave-retry" />
      ) : null}
      <Choice label={HELD_LEAVE_LEAVE} onPress={onLeave} testID="held-leave-leave" />
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
    alignSelf: 'center',
  },
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingVertical: spacing(1.5),
  },
  primary: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.primary,
    marginTop: spacing(1),
  },
  primaryLabel: {
    ...editorialType.note,
    color: colors.text.light,
    fontWeight: '600',
  },
  secondary: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing(0.5),
  },
  secondaryLabel: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
});

export default HeldWordsLeaveDialog;
