import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { accent, ink, rhythm, type as typeRamp } from '@/design/tokens';

interface ScreenHeaderProps {
  /** The serif display title (rendered with `accessibilityRole="header"`). */
  title: string;
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
        <Text style={[t.display, styles.title]} accessibilityRole="header">
          {title}
        </Text>
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

export default ScreenHeader;
