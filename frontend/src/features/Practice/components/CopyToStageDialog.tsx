import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  ink,
  surface,
  surfaceShadow,
} from '@/design/tokens';
import { stageLabel } from '@/features/Practice/utils/stageDisplayName';

const NAME_REQUIRED_MESSAGE = 'Name is required.';

export interface CopyDialogText {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * Pure copy for the confirm-and-copy dialog — a warm, declinable offer that
 * names what will happen (make your own copy), why (the practice lives in
 * another stage), what you get (your own version here), and the escape (the
 * original stays put; Cancel backs out).
 */
export function copyDialogText(
  name: string,
  homeStage: number,
  targetStage: number,
): CopyDialogText {
  return {
    title: `Make your own copy of ${name}?`,
    message: `This practice lives in ${stageLabel(homeStage)}. Making a copy gives you your own version in ${stageLabel(targetStage)} — the original stays right where it is.`,
    confirmLabel: 'Make a copy',
    cancelLabel: 'Cancel',
  };
}

export interface CopyToStageDialogProps {
  visible: boolean;
  practiceName: string;
  homeStage: number;
  targetStage: number;
  busy: boolean;
  /** Yields the edited (possibly renamed) copy name so the caller can copy under it. */
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * Declinable confirm-and-copy dialog shown when a user asks to use a practice
 * in a stage other than its home stage.
 *
 * Mirrors the ``ConfirmDialog`` structure: ``visible`` drives the ``<Modal>``
 * fade while the body is gated so nothing renders when hidden. The gated body
 * is its own component, so its local name field remounts (and reseeds from
 * ``practiceName``) every time the dialog reopens. Both controls are inert
 * while ``busy`` so a slow copy can't be double-submitted and the escape can't
 * fire mid-write.
 */
export const CopyToStageDialog = ({
  visible,
  practiceName,
  homeStage,
  targetStage,
  busy,
  onConfirm,
  onCancel,
}: CopyToStageDialogProps): React.JSX.Element => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
    {visible && (
      <CopyDialogBody
        practiceName={practiceName}
        homeStage={homeStage}
        targetStage={targetStage}
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )}
  </Modal>
);

type CopyDialogBodyProps = Omit<CopyToStageDialogProps, 'visible'>;

/**
 * The gated dialog surface — split out so its local name state is fresh per
 * open, seeded from ``practiceName``. The confirm control is disabled (with an
 * inline required message) while the trimmed name is empty.
 */
const CopyDialogBody = ({
  practiceName,
  homeStage,
  targetStage,
  busy,
  onConfirm,
  onCancel,
}: CopyDialogBodyProps): React.JSX.Element => {
  const text = copyDialogText(practiceName, homeStage, targetStage);
  const [name, setName] = useState(practiceName);
  const nameEmpty = name.trim().length === 0;
  const confirmDisabled = busy || nameEmpty;
  return (
    <View style={styles.overlay} testID="practice-copy-dialog">
      <View style={styles.dialog}>
        <Text style={styles.title}>{text.title}</Text>
        <Text style={styles.message}>{text.message}</Text>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          accessibilityLabel="Copy name"
          value={name}
          onChangeText={setName}
          autoFocus
          style={styles.input}
          testID="practice-copy-dialog-name"
        />
        {nameEmpty && (
          <Text style={styles.required} testID="practice-copy-dialog-name-error">
            {NAME_REQUIRED_MESSAGE}
          </Text>
        )}
        <DialogActions
          cancelLabel={text.cancelLabel}
          confirmLabel={text.confirmLabel}
          busy={busy}
          confirmDisabled={confirmDisabled}
          onCancel={onCancel}
          onConfirm={() => onConfirm(name)}
        />
      </View>
    </View>
  );
};

interface DialogActionsProps {
  cancelLabel: string;
  confirmLabel: string;
  busy: boolean;
  confirmDisabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Cancel/confirm control row; both controls inert while ``busy``. */
const DialogActions = ({
  cancelLabel,
  confirmLabel,
  busy,
  confirmDisabled,
  onCancel,
  onConfirm,
}: DialogActionsProps): React.JSX.Element => (
  <View style={styles.actions}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={cancelLabel}
      accessibilityState={{ disabled: busy }}
      onPress={busy ? undefined : onCancel}
      style={styles.cancelButton}
      testID="practice-copy-dialog-cancel"
    >
      <Text style={styles.cancelText}>{cancelLabel}</Text>
    </TouchableOpacity>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={confirmLabel}
      accessibilityState={{ disabled: confirmDisabled }}
      onPress={confirmDisabled ? undefined : onConfirm}
      style={[styles.confirmButton, confirmDisabled && styles.confirmButtonBusy]}
      testID="practice-copy-dialog-confirm"
    >
      <Text style={styles.confirmText}>{confirmLabel}</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
    backgroundColor: colors.mystical.overlay,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...surfaceShadow.card,
  },
  title: { fontSize: 16, fontWeight: '700', color: ink.primary },
  message: { fontSize: 14, color: ink.soft, lineHeight: 20 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: ink.soft, marginTop: SPACING.sm },
  input: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: ink.primary,
    backgroundColor: surface.raised,
    marginTop: SPACING.xs,
  },
  required: { fontSize: 12, color: colors.destructive.text, marginTop: SPACING.xs },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  cancelButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  cancelText: { color: ink.primary, fontWeight: '600', fontSize: 13 },
  confirmButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: accent.primary,
    borderColor: accent.primary,
    borderWidth: 1,
  },
  confirmButtonBusy: { opacity: 0.5 },
  confirmText: { color: accent.onPrimary, fontWeight: '700', fontSize: 13 },
});

export default CopyToStageDialog;
