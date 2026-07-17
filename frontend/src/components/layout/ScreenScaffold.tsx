import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { BottomFade } from './BottomFade';
import { ContentContainer } from './ContentContainer';

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
      <View style={styles.ground}>
        <ScrollView
          style={styles.fill}
          // Invariant: only the ScrollView content container grows. The inner
          // wrapper stays content-sized so the native contentSize tracks the real
          // content height (fills when short, scrolls when tall — journal idiom).
          // The BottomFade is an absolutely-positioned sibling (not a scroll
          // child) so it stays pinned while content scrolls beneath it.
          contentContainerStyle={[styles.content, styles.scrollContent, style]}
          testID={testID}
        >
          <ContentContainer>{children}</ContentContainer>
        </ScrollView>
        <BottomFade />
      </View>
    );
  }
  return (
    <View style={[styles.ground, styles.content, style]} testID={testID}>
      <ContentContainer fill>{children}</ContentContainer>
    </View>
  );
};

const styles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: surface.canvas,
  },
  fill: {
    flex: 1,
  },
  content: {
    paddingHorizontal: rhythm.screenPaddingH,
    paddingTop: rhythm.screenPaddingTop,
  },
  scrollContent: {
    flexGrow: 1,
    // Clear the BottomFade veil so the final line of content is never masked.
    paddingBottom: rhythm.bottomFadeHeight,
  },
});
