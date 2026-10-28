import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { editorialType, onShowcase, SPACING, touchTarget } from '@/design/tokens';
import type { OfferActionProps } from '@/features/Journal/OfferAction';

/** Practice's inline actions sit on umber; the modal picker keeps the paper actions. */
export default function PracticeHabitAction({
  label,
  a11yLabel,
  onPress,
  testID,
}: Pick<OfferActionProps, 'label' | 'a11yLabel' | 'onPress' | 'testID'>): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.action}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      onPress={onPress}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
    </TouchableOpacity>
  );
}
const styles = StyleSheet.create({
  action: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  label: { ...editorialType.action, color: onShowcase.soft },
});
