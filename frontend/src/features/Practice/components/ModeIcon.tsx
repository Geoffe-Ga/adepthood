/**
 * ``ModeIcon`` — the leading glyph on every practice-mode row (#2963).
 *
 * The catalog's practice and recently-used rows and the Create Practice
 * wizard's mode picker all lead with the mode's lucide icon. It is decoration:
 * each row already names its mode in its own ``accessibilityLabel``, so the
 * slot is hidden from every screen reader -- VoiceOver, TalkBack and the web's,
 * through ``decorativeHidden`` -- here, once, rather than at each call site.
 */

import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { decorativeHidden } from '@/components/a11yHidden';
import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/drawer';
import { SPACING, ink } from '@/design/tokens';

/** Size (px) of a mode row's glyph: the app's leading-row icon size. */
export const MODE_ICON_SIZE = NAV_ICON_SIZE;
/** Width (px) of the slot the glyph centres in, so row text starts on one edge. */
export const MODE_ICON_SLOT = MODE_ICON_SIZE + SPACING.sm;

export interface ModeIconProps {
  /** The mode's lucide icon, from ``MODE_CATEGORIES`` or ``FALLBACK_MODE_ICON``. */
  icon: LucideIcon;
  testID?: string;
}

/** Draw a mode's icon in a fixed-width slot that assistive tech skips. */
const ModeIcon = ({ icon: Icon, testID }: ModeIconProps): React.JSX.Element => (
  <View style={styles.slot} {...decorativeHidden()} testID={testID}>
    <Icon color={ink.soft} size={MODE_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} />
  </View>
);

const styles = StyleSheet.create({
  slot: { width: MODE_ICON_SLOT, alignItems: 'center' },
});

export default ModeIcon;
