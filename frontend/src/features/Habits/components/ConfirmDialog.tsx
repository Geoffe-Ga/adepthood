import React from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';

import styles from '../Habits.styles';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  testID?: string;
  cancelTestID?: string;
  confirmTestID?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Cross-platform confirmation dialog. `Alert.alert` collapses to a no-op on
 * React Native Web mobile browsers, so destructive flows that depend on the
 * user explicitly confirming need a rendered modal — this is that modal.
 */
export const ConfirmDialog = ({
  visible,
  title,
  message,
  testID,
  cancelTestID,
  confirmTestID,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) => {
  if (!visible) return null;
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay} testID={testID}>
        <View style={styles.discardModal}>
          <Text style={styles.discardTitle}>{title}</Text>
          {message && <Text style={styles.discardMessage}>{message}</Text>}
          <View style={styles.discardActions}>
            <TouchableOpacity onPress={onCancel} style={styles.discardButton} testID={cancelTestID}>
              <Text style={styles.discardButtonText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onConfirm}
              style={styles.discardButton}
              testID={confirmTestID}
            >
              <Text style={destructive ? styles.discardExitText : styles.discardButtonText}>
                {confirmLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

export default ConfirmDialog;
