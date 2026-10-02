import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { SettingsSwitch } from './SettingsSwitch';

import { accent, ink, rhythm, surface, touchTarget, type as typeRamp } from '@/design/tokens';

/**
 * One Settings row whose control is a switch: an optional icon, a label, a
 * description, an optional status line, and the switch itself on the right.
 * The sibling of ``SettingsRow`` for a choice that is a standing state rather
 * than a destination — the label names the state, the description says what
 * it does and where it is kept, the status says what the server last
 * reported, and the switch position is the answer.
 *
 * Shared so every switch row in Settings agrees on icon inset, touch target,
 * hairline, type ramp and the accessibility pairing of label and state.
 * ``disabled`` greys the whole row, not only the switch, so a row that cannot
 * be changed right now reads that way at a glance. ``children`` render under
 * the row head, inside its hairline — for the question a withdrawal asks.
 */

const ICON_SIZE = 22;
/** Opacity of a row whose switch is disabled: legible, plainly inert. */
const DISABLED_OPACITY = 0.45;
/** Where a row's text starts when it carries an icon, for text set beside such rows. */
export const SETTINGS_ROW_TEXT_INSET = ICON_SIZE + rhythm.blockGap;

export interface SettingsRowTextProps {
  label: string;
  description: string;
  /** A third, muted line: what the server last said, or why there is no control. */
  status?: string;
  statusTestID?: string;
}

/** The label, description and optional status of a Settings row, on the ramp. */
export const SettingsRowText = ({
  label,
  description,
  status,
  statusTestID,
}: SettingsRowTextProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.rowText}>
      <Text style={[t.label, styles.rowLabel]}>{label}</Text>
      <Text style={[t.caption, styles.rowDescription]}>{description}</Text>
      {status === undefined ? null : (
        <Text style={[t.caption, styles.rowStatus]} testID={statusTestID}>
          {status}
        </Text>
      )}
    </View>
  );
};

export interface SettingsSwitchRowProps extends SettingsRowTextProps {
  icon?: LucideIcon;
  value: boolean;
  onValueChange: (_next: boolean) => void;
  testID: string;
  /** The switch's own testID; ``<testID>-switch`` unless a caller already names it. */
  switchTestID?: string;
  /** Greys the row and refuses changes — while a write is in flight, say. */
  disabled?: boolean;
  /** Rendered under the row head, inside the row: a confirmation, a note. */
  children?: React.ReactNode;
}

export const SettingsSwitchRow = ({
  icon: Icon,
  label,
  description,
  status,
  statusTestID,
  value,
  onValueChange,
  testID,
  switchTestID,
  disabled = false,
  children,
}: SettingsSwitchRowProps): React.JSX.Element => (
  <View style={[styles.row, disabled ? styles.rowDisabled : null]} testID={testID}>
    <View style={styles.rowHead}>
      {Icon ? (
        <View style={styles.iconSlot}>
          <Icon color={accent.primary} size={ICON_SIZE} />
        </View>
      ) : null}
      <SettingsRowText
        label={label}
        description={description}
        status={status}
        statusTestID={statusTestID}
      />
      <SettingsSwitch
        testID={switchTestID ?? `${testID}-switch`}
        accessibilityLabel={label}
        accessibilityHint={description}
        accessibilityState={{ checked: value, disabled }}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
      />
    </View>
    {children}
  </View>
);

const styles = StyleSheet.create({
  row: {
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.minimum,
  },
  rowDisabled: {
    opacity: DISABLED_OPACITY,
  },
  iconSlot: {
    width: SETTINGS_ROW_TEXT_INSET,
  },
  rowText: {
    flex: 1,
    marginRight: rhythm.blockGap,
  },
  rowLabel: {
    color: ink.primary,
  },
  rowDescription: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
  },
  rowStatus: {
    color: ink.muted,
    marginTop: rhythm.blockGap / 3,
  },
});
