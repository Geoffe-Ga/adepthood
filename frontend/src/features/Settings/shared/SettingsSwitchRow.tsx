import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';

import { accent, ink, rhythm, surface, touchTarget, type as typeRamp } from '@/design/tokens';

/**
 * One Settings row whose control is a switch: an optional icon, a label, a
 * description, and the switch itself on the right. The sibling of
 * ``SettingsRow`` for a choice that is a standing state rather than a
 * destination — the label names the state, the description says what it does
 * and where it is kept, and the switch position is the answer.
 *
 * Shared so every switch row in Settings agrees on touch target, hairline,
 * and the accessibility pairing of label and state. ``disabled`` greys the
 * whole row, not only the switch, so a row that cannot be changed right now
 * reads that way at a glance.
 */

const ICON_SIZE = 22;
/** Opacity of a row whose switch is disabled: legible, plainly inert. */
const DISABLED_OPACITY = 0.45;

export interface SettingsSwitchRowProps {
  icon?: LucideIcon;
  label: string;
  description: string;
  value: boolean;
  onValueChange: (_next: boolean) => void;
  testID: string;
  /** Greys the row and refuses changes — while a write is in flight, say. */
  disabled?: boolean;
}

export const SettingsSwitchRow = ({
  icon: Icon,
  label,
  description,
  value,
  onValueChange,
  testID,
  disabled = false,
}: SettingsSwitchRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={[styles.row, disabled ? styles.rowDisabled : null]} testID={testID}>
      {Icon ? <Icon color={accent.primary} size={ICON_SIZE} /> : null}
      <View style={[styles.rowText, Icon ? styles.rowTextAfterIcon : null]}>
        <Text style={[t.label, styles.rowLabel]}>{label}</Text>
        <Text style={[t.caption, styles.rowDescription]}>{description}</Text>
      </View>
      <Switch
        testID={`${testID}-switch`}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityHint={description}
        accessibilityState={{ checked: value, disabled }}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: surface.hairline, true: accent.primary }}
        thumbColor={surface.raised}
      />
    </View>
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
  rowDisabled: {
    opacity: DISABLED_OPACITY,
  },
  rowText: {
    flex: 1,
    marginRight: rhythm.blockGap,
  },
  rowTextAfterIcon: {
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
