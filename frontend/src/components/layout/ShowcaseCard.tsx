import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { BORDER_RADIUS, rhythm, showcase, showcaseShadow } from '@/design/tokens';

interface ShowcaseCardProps {
  children: React.ReactNode;
  /** Extra style merged onto the umber band. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A rounded warm-umber showcase band (#826) — the "designed product" hero
 * moment on an otherwise light screen. Establishes the on-showcase surface;
 * text inside should use the `onShowcase` ink tokens (which clear AA on this
 * ground). Token-only, portable `showcaseShadow`.
 */
export const ShowcaseCard = ({ children, style, testID }: ShowcaseCardProps): React.JSX.Element => (
  <View style={[styles.band, style]} testID={testID}>
    {children}
  </View>
);

const styles = StyleSheet.create({
  band: {
    backgroundColor: showcase.canvas,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: rhythm.heroPaddingV,
    paddingHorizontal: rhythm.screenPaddingH,
    ...showcaseShadow,
  },
});
