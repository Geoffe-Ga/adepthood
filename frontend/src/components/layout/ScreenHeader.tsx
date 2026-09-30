import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { accent, ink, rhythm, type as typeRamp } from '@/design/tokens';

interface ScreenHeaderProps {
  /** The serif display title (rendered with `accessibilityRole="header"`). */
  title: string;
  /**
   * Set when the stack header already paints ``title`` (#2962): navigation is
   * then the screen's one title heading, so the body paints no title and adds
   * no header node for it -- a second one would announce the title twice. The
   * eyebrow and lead still render as ordinary text.
   */
  titleHidden?: boolean;
  /** Small-caps caption above the title. */
  eyebrow?: string;
  /** Optional lead paragraph beneath the title. */
  lead?: string;
  /** Optional right-aligned action (e.g. a button); should be ≥44dp itself. */
  action?: React.ReactNode;
  testID?: string;
}

const EYEBROW_LETTER_SPACING = 1.5;

/**
 * Editorial screen header (#825): eyebrow → serif `type().display` title → lead,
 * with an optional right-aligned action slot. Responsive-scale aware via
 * `type(width)`; token-only and AA on `surface.canvas`.
 */
export const ScreenHeader = ({
  title,
  titleHidden,
  eyebrow,
  lead,
  action,
  testID,
}: ScreenHeaderProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.text}>
        {eyebrow ? <Text style={[t.caption, styles.eyebrow]}>{eyebrow.toUpperCase()}</Text> : null}
        {titleHidden ? null : (
          <Text style={[t.display, styles.title]} accessibilityRole="header">
            {title}
          </Text>
        )}
        {lead ? <Text style={[t.body, styles.lead]}>{lead}</Text> : null}
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: rhythm.heroPaddingV,
  },
  text: {
    flex: 1,
  },
  eyebrow: {
    color: accent.primary,
    letterSpacing: EYEBROW_LETTER_SPACING,
    marginBottom: rhythm.blockGap,
  },
  title: {
    color: ink.primary,
  },
  lead: {
    color: ink.soft,
    marginTop: rhythm.blockGap,
  },
  action: {
    marginLeft: rhythm.blockGap,
  },
});
