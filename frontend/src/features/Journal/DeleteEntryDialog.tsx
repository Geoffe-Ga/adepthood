/**
 * ``DeleteEntryDialog`` — the one ask before a page leaves the journal.
 *
 * Same small card over the dimmed shelf that ``EditConfirmDialog`` uses, for
 * the same reason: a destructive act gets a deliberate beat, not a swipe. The
 * words live in ``deleteEntryCopy`` so the promise this dialog makes can be
 * read, and tested, in one place.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import {
  DELETE_ENTRY_BODY,
  DELETE_ENTRY_CANCEL,
  DELETE_ENTRY_CONFIRM,
  DELETE_ENTRY_TITLE,
} from './deleteEntryCopy';
import JournalModalShell from './JournalModalShell';

import { BORDER_RADIUS, colors, editorialType, spacing, touchTarget } from '@/design/tokens';

export interface DeleteEntryDialogProps {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteEntryDialog({
  visible,
  onConfirm,
  onCancel,
}: DeleteEntryDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onCancel}
      scrimTestID="journal-delete-scrim"
      scrimLabel="Keep this page"
      cardTestID="journal-delete-dialog"
    >
      <Text style={styles.title}>{DELETE_ENTRY_TITLE}</Text>
      <Text style={styles.body} testID="journal-delete-dialog-body">
        {DELETE_ENTRY_BODY}
      </Text>
      <TouchableOpacity
        style={styles.destructive}
        onPress={onConfirm}
        accessibilityRole="button"
        accessibilityLabel="Delete this page"
        testID="journal-delete-confirm"
      >
        <Text style={styles.destructiveLabel}>{DELETE_ENTRY_CONFIRM}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.secondary}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Keep this page"
        testID="journal-delete-cancel"
      >
        <Text style={styles.secondaryLabel}>{DELETE_ENTRY_CANCEL}</Text>
      </TouchableOpacity>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingVertical: spacing(1.5),
  },
  destructive: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.danger,
    marginTop: spacing(1),
  },
  destructiveLabel: {
    ...editorialType.action,
    color: colors.text.light,
  },
  secondary: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing(0.5),
  },
  secondaryLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
    fontWeight: '400',
  },
});

export default DeleteEntryDialog;
