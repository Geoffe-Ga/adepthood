import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { rhythm, surface } from '@/design/tokens';

interface ScreenScaffoldProps {
  children: React.ReactNode;
  /** Wrap the content in a vertical ScrollView (for long screens). */
  scroll?: boolean;
  /** Extra style merged onto the padded content container. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The "this is an Adepthood screen" container (#825): a warm `surface.canvas`
 * ground with the shared `rhythm` horizontal/top padding, optionally scrollable.
 * Token-only so every screen inherits the same editorial rhythm.
 */
export const ScreenScaffold = ({
  children,
  scroll = false,
  style,
  testID,
}: ScreenScaffoldProps): React.JSX.Element => {
  if (scroll) {
    return (
      <ScrollView
        style={styles.ground}
        contentContainerStyle={[styles.content, style]}
        testID={testID}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <View style={[styles.ground, styles.content, style]} testID={testID}>
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: surface.canvas,
  },
  content: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingTop: rhythm.screenPaddingTop,
  },
});

export default ScreenScaffold;
