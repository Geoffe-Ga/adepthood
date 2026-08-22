import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { accent, ink, rhythm, surface, touchTarget, type as typeRamp } from '@/design/tokens';

/**
 * One tappable Settings row: an icon, a label, a description, and — unless the
 * action is destructive — the chevron that says a destination follows.
 *
 * Shared rather than copied, so a second group of rows cannot drift away from
 * the first on touch target, hairline, or the accessibility pairing of label
 * and hint.
 */

const ICON_SIZE = 22;
const CHEVRON_SIZE = 20;

export interface SettingsRowProps {
  icon: LucideIcon;
  label: string;
  description: string;
  onPress: () => void;
  testID: string;
  /** Tints the row and drops the chevron: this ends something, it goes nowhere. */
  destructive?: boolean;
}

export const SettingsRow = ({
  icon: Icon,
  label,
  description,
  onPress,
  testID,
  destructive = false,
}: SettingsRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const tint = destructive ? accent.strong : accent.primary;
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      testID={testID}
    >
      <Icon color={tint} size={ICON_SIZE} />
      <View style={styles.rowText}>
        <Text style={[t.label, styles.rowLabel]}>{label}</Text>
        <Text style={[t.caption, styles.rowDescription]}>{description}</Text>
      </View>
      {destructive ? null : <ChevronRight color={ink.muted} size={CHEVRON_SIZE} />}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.minimum,
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowText: {
    flex: 1,
    marginLeft: rhythm.blockGap,
  },
  rowLabel: {
    color: ink.primary,
  },
  rowDescription: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
  },
});
