/**
 * A single tappable row inside a screen drawer: an optional leading icon slot
 * followed by a label. The label doubles as the default accessibility label so
 * screen-reader users hear the same text sighted users see.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions } from 'react-native';

import { ink, SPACING, touchTarget, type } from '@/design/tokens';

export interface DrawerItemProps {
  /** Visible row label; also the default accessibility label. */
  label: string;
  /** Fired when the row is pressed. */
  onPress: () => void;
  /** Optional leading visual rendered before the label. */
  icon?: React.ReactNode;
  /** Overrides the announced label when it should differ from the text. */
  accessibilityLabel?: string;
  /** Test hook for the row. */
  testID?: string;
}

/** A drawer row with an optional icon slot and an accessible label. */
export default function DrawerItem({
  label,
  onPress,
  icon,
  accessibilityLabel,
  testID,
}: DrawerItemProps): React.JSX.Element {
  const { width } = useWindowDimensions();

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
    >
      {icon}
      <Text style={[type(width).body, styles.label]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: touchTarget.minimum,
  },
  label: {
    color: ink.primary,
  },
});
