/**
 * The drawer's hairline divider: the line that sets one group of drawer rows
 * apart from the next (the nav section from the screen's own rows, a door from
 * the list beneath it). One definition, so every break in a drawer reads alike.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { SPACING, surface } from '@/design/tokens';

export interface DrawerDividerProps {
  /** Test hook naming which break this divider marks. */
  testID?: string;
}

/** A full-width hairline with the drawer's standard breathing room above and below. */
export default function DrawerDivider({ testID }: DrawerDividerProps): React.JSX.Element {
  return <View testID={testID} style={styles.divider} />;
}

const styles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: surface.hairline,
    marginVertical: SPACING.sm,
  },
});
