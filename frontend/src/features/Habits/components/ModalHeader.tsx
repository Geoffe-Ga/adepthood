import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors as COLORS, SPACING } from '../../../design/tokens';

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
    borderColor: '#eee',
    paddingBottom: SPACING.md,
    marginBottom: SPACING.md,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    color: COLORS.text.primary,
  },
  closeButton: {
    padding: SPACING.xs,
  },
  closeButtonText: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
    color: COLORS.text.secondary,
  },
});

export default ModalHeader;
