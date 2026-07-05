import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { editorialType, ink, SPACING, surface } from '../../../design/tokens';

interface ModalHeaderProps {
  title: React.ReactNode;
  onClose: () => void;
  closeTestID?: string;
  children?: React.ReactNode;
}

/**
 * Shared title-plus-close header for Habits modals. Renders the modal title,
 * any inline controls passed as children, and the trailing close button.
 */
const ModalHeader = ({ title, onClose, closeTestID, children }: ModalHeaderProps) => (
  <View style={styles.modalHeader}>
    <Text style={styles.modalTitle}>{title}</Text>
    {children}
    <TouchableOpacity onPress={onClose} style={styles.closeButton} testID={closeTestID}>
      <Text style={styles.closeButtonText}>×</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: surface.hairline,
    paddingBottom: SPACING.md,
    marginBottom: SPACING.md,
  },
  modalTitle: {
    ...editorialType.title,
    color: ink.primary,
    flex: 1,
  },
  closeButton: {
    padding: SPACING.xs,
  },
  closeButtonText: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
    color: ink.soft,
  },
});

export default ModalHeader;
