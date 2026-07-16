import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Declinable confirm-and-copy dialog shown when a user asks to use a practice
 * in a stage other than its home stage.
 *
 * Mirrors the ``ConfirmDialog`` structure: ``visible`` drives the ``<Modal>``
 * fade while the body is gated so nothing renders when hidden. Both controls
 * are inert while ``busy`` so a slow copy can't be double-submitted and the
 * escape can't fire mid-write.
 */
export const CopyToStageDialog = ({
  visible,
  practiceName,
  homeStage,
  targetStage,
  busy,
  onConfirm,
  onCancel,
}: CopyToStageDialogProps): React.JSX.Element => {
  const text = copyDialogText(practiceName, homeStage, targetStage);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {visible && (
        <View style={styles.overlay} testID="practice-copy-dialog">
          <View style={styles.dialog}>
            <Text style={styles.title}>{text.title}</Text>
            <Text style={styles.message}>{text.message}</Text>
            <View style={styles.actions}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={text.cancelLabel}
                accessibilityState={{ disabled: busy }}
                onPress={busy ? undefined : onCancel}
                style={styles.cancelButton}
                testID="practice-copy-dialog-cancel"
              >
                <Text style={styles.cancelText}>{text.cancelLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={text.confirmLabel}
                accessibilityState={{ disabled: busy }}
                onPress={busy ? undefined : onConfirm}
                style={[styles.confirmButton, busy && styles.confirmButtonBusy]}
                testID="practice-copy-dialog-confirm"
              >
                <Text style={styles.confirmText}>{text.confirmLabel}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
};

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
