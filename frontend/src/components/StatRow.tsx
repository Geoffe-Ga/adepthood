/**
 * `StatRow` — one label-and-figure line in a stats block.
 *
 * Lifted out of the Habits `StatsModal`, where it was a local helper, so the
 * Practice detail screen reports a practitioner's investment in the same visual
 * language rather than inventing a second one (#2449). The styles moved with it
 * unchanged; `Habits.styles` no longer carries `statsRow` / `statLabel` /
 * `statValue`, since this is now their only reader.
 *
 * `valueTestID` exists so a caller can address the *figure* rather than the
 * line: a spec asserting a total wants to fail when the number is wrong, not
 * when the label beside it is reworded.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, surface } from '@/design/tokens';

export interface StatRowProps {
  label: string;
  value: string;
  testID?: string;
  valueTestID?: string;
}

export const StatRow = ({ label, value, testID, valueTestID }: StatRowProps): React.JSX.Element => (
  <View style={styles.row} testID={testID}>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.value} testID={valueTestID}>
      {value}
    </Text>
  </View>
);

/** The container a run of `StatRow`s sits in. */
export const StatList = ({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element => (
  <View style={styles.list} testID={testID}>
    {children}
  </View>
);

const styles = StyleSheet.create({
  list: {
    marginTop: SPACING.lg,
    backgroundColor: surface.canvas,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderColor: surface.hairline,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
  },
  value: {
    fontSize: 15,
    color: colors.text.secondary,
  },
});

export default StatRow;
