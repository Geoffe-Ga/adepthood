/**
 * Header-left toggle that opens a screen's contextual drawer. Mirrors the stable
 * ``TabHeaderRight`` pattern in ``BottomTabs`` so it is defined once at module
 * scope rather than being re-created on every render of its host screen.
 */
import { Menu } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';

import { accent, SPACING, touchTarget } from '@/design/tokens';

/** Lucide glyph size in dp for the toggle's menu icon. */
const MENU_ICON_SIZE = 24;

export interface DrawerToggleProps {
  /** Human-readable screen name used to build the accessibility label. */
  screenName: string;
  /** Whether the drawer this toggle controls is currently open. */
  expanded: boolean;
  /** Fired when the toggle is pressed. */
  onPress: () => void;
  /** Test hook; defaults to ``drawer-toggle``. */
  testID?: string;
}

/** A button that opens a screen's drawer, announced with its expanded state. */
export default function DrawerToggle({
  screenName,
  expanded,
  onPress,
  testID,
}: DrawerToggleProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.toggle}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${screenName} menu`}
      accessibilityState={{ expanded }}
      testID={testID ?? 'drawer-toggle'}
    >
      <Menu color={accent.primary} size={MENU_ICON_SIZE} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  toggle: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: SPACING.sm,
  },
});
