/**
 * ``HeldWordsLeaveDialog`` — asked before leaving a page whose offline words are
 * still waiting to be put back (#2935). Those words live only in this screen
 * until they are saved, so leaving drops them; the page never lets that happen
 * silently. Staying is the default. Where the words wait on a privacy setting
 * that failed to save, trying that save again is offered too. If the words come
 * back onto the page while it is open, it says so instead of warning.
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
  'The words you wrote while this page couldn’t open, and anything you’ve written here since, haven’t been saved yet. If you leave now, they won’t come with you.';

/** The heading once the words are back on the page while the dialog is open. */
export const HELD_LEAVE_RELEASED_TITLE = 'Your offline words are back';

/** Leaving is safe again: the words are on the page and saving with it. */
export const HELD_LEAVE_RELEASED_BODY =
  'They’re on the page again and saving with it, so nothing is left behind if you leave.';

export const HELD_LEAVE_RELEASED_LEAVE = 'Leave';

export const HELD_LEAVE_STAY = 'Stay';
export const HELD_LEAVE_RETRY = 'Try saving again';
export const HELD_LEAVE_LEAVE = 'Leave without them';

export interface HeldWordsLeaveDialogProps {
  visible: boolean;
  onStay: () => void;
  onLeave: () => void;
  /** Offered only when the words wait on a privacy setting that failed to save. */
  onRetry?: () => void;
  /**
   * The words came back onto the page while the dialog was open: nothing is
   * left behind any more, so the dialog says so and leaving is plain.
   */
  released?: boolean;
}

const HELD_COPY = { title: HELD_LEAVE_TITLE, body: HELD_LEAVE_BODY, leave: HELD_LEAVE_LEAVE };
const RELEASED_COPY = {
  title: HELD_LEAVE_RELEASED_TITLE,
  body: HELD_LEAVE_RELEASED_BODY,
  leave: HELD_LEAVE_RELEASED_LEAVE,
};

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
  released = false,
}: HeldWordsLeaveDialogProps): React.JSX.Element {
  const copy = released ? RELEASED_COPY : HELD_COPY;
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onStay}
      scrimTestID="held-leave-scrim"
      scrimLabel={HELD_LEAVE_STAY}
      cardTestID="held-leave-dialog"
      cardStyle={styles.card}
    >
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Choice label={HELD_LEAVE_STAY} onPress={onStay} testID="held-leave-stay" primary />
      {onRetry ? (
        <Choice label={HELD_LEAVE_RETRY} onPress={onRetry} testID="held-leave-retry" />
      ) : null}
      <Choice label={copy.leave} onPress={onLeave} testID="held-leave-leave" />
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
