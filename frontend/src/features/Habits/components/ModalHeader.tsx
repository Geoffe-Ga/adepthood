import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { decorativeHidden } from '../../../components/a11yHidden';
import { editorialType, ink, SPACING, surface, touchTarget } from '../../../design/tokens';

import { MODAL_CLOSE_LABEL } from './modalCloseLabels';

interface ModalHeaderProps {
  title: React.ReactNode;
  onClose: () => void;
  /**
   * Accessible name of the close button. Pass the modal's own label from
   * ``modalCloseLabels``: the title may be a ReactNode, so no name can be
   * derived from it, and a bare default can collide with other controls.
   */
  closeLabel?: string;
  closeTestID?: string;
  children?: React.ReactNode;
}

/**
 * Shared title-plus-close header for Habits modals. Renders the modal title,
 * any inline controls passed as children, and the trailing close button: a
 * named button at least ``touchTarget.minimum`` square whose "×" glyph is
 * hidden from assistive tech, so a reader announces the name alone.
 */
const ModalHeader = ({
  title,
  onClose,
  closeLabel = MODAL_CLOSE_LABEL,
  closeTestID,
  children,
}: ModalHeaderProps) => (
  <View style={styles.modalHeader}>
    <Text style={styles.modalTitle}>{title}</Text>
    {children}
    <TouchableOpacity
      onPress={onClose}
      style={styles.closeButton}
      testID={closeTestID}
      accessibilityRole="button"
      accessibilityLabel={closeLabel}
    >
      <Text style={styles.closeButtonText} {...decorativeHidden()}>
        ×
      </Text>
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
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
    color: ink.soft,
  },
});

export default ModalHeader;
