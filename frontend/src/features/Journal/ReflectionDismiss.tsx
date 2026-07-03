/** Shared dismiss affordance for the raised reflection cards — identical chrome. */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { SPACING, editorialType, ink, touchTarget } from '@/design/tokens';

export interface ReflectionDismissProps {
  label: string;
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
}

function ReflectionDismiss({
  label,
  accessibilityLabel,
  testID,
  onPress,
}: ReflectionDismissProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.dismiss}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text style={styles.dismissText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  dismiss: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissText: {
    ...editorialType.note,
    fontWeight: '600',
    color: ink.soft,
  },
});

export default ReflectionDismiss;
