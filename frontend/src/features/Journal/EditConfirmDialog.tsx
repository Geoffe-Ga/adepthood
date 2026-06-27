/**
 * ``EditConfirmDialog`` — makes editing a *finished* (resonated) entry a
 * deliberate act. Editing can shift the passages the margin notes anchor to, so
 * we ask first: keep editing this one, start a fresh page, or cancel. A small
 * card over the dimmed, still-visible page.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';

export interface EditConfirmDialogProps {
  visible: boolean;
  onEdit: () => void;
  onStartNew: () => void;
  onCancel: () => void;
}

/** No-op so the card's tap-capture doesn't allocate a function per render. */
const NOOP = (): void => {};

interface ChoiceProps {
  label: string;
  onPress: () => void;
  a11y: string;
  testID: string;
  primary?: boolean;
}

function Choice({ label, onPress, a11y, testID, primary = false }: ChoiceProps) {
  return (
    <TouchableOpacity
      style={primary ? styles.primary : styles.secondary}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      testID={testID}
    >
      <Text style={primary ? styles.primaryLabel : styles.secondaryLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function EditConfirmDialog({
  visible,
  onEdit,
  onStartNew,
  onCancel,
}: EditConfirmDialogProps): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={styles.scrim}
        onPress={onCancel}
        testID="edit-confirm-scrim"
        accessibilityLabel="Dismiss"
      >
        <Pressable style={styles.card} onPress={NOOP} testID="edit-confirm-dialog">
          <Text style={styles.title}>Edit finished entry?</Text>
          <Text style={styles.body}>
            This entry has its resonance. Editing it may move or unsettle the margin notes — they’ll
            re-anchor where they still fit and dim where they no longer do.
          </Text>
          <Choice
            label="Edit"
            onPress={onEdit}
            a11y="Edit this entry"
            testID="edit-confirm-edit"
            primary
          />
          <Choice
            label="Start new"
            onPress={onStartNew}
            a11y="Start a new entry"
            testID="edit-confirm-start-new"
          />
          <Choice label="Cancel" onPress={onCancel} a11y="Cancel" testID="edit-confirm-cancel" />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  card: {
    padding: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: colors.paper.background,
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

export default EditConfirmDialog;
