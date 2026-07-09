import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { contentLayout } from '@/design/tokens';

interface ContentContainerProps {
  children: React.ReactNode;
  /**
   * Make the container a bounded ``flex: 1`` box for definite-height parents
   * that host a nested scroller or a flex-sized body. Defaults to ``false``,
   * leaving the container main-axis-inert (a pure width cap).
   */
  fill?: boolean;
  /** Extra style merged onto the shared content-capped container. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The shared content-width cap: a full-width box centered and capped at
 * ``contentLayout.maxWidth`` so screen bodies settle on the same comfortable
 * reading measure on tablets and wide web instead of stretching edge-to-edge.
 *
 * This container is used across two distinct surfaces, and the default is
 * deliberately main-axis-inert to keep both native height chains intact:
 *
 * - **Default (no ``fill``): a pure width cap.** It sets no ``flex`` or
 *   ``flexGrow`` of its own, so it stays content-sized on the main axis. This
 *   is what makes it safe as a child of a ScrollView content container whose
 *   own ``contentContainerStyle`` owns the single grow — the native
 *   ``contentSize`` then tracks the real content height and scrolling works.
 * - **``fill``: a bounded ``flex: 1`` box.** For definite-height parents (a
 *   ``flex: 1`` ground) that host a nested scroller or a flex-sized body, this
 *   gives the wrapper a bounded height so the nested scroller inherits real
 *   bounds and can scroll natively.
 *
 * Callers wrap their scroll/flow body in this; a caller ``style`` is merged on
 * top (last) without dropping the width cap.
 */
export const ContentContainer = ({
  children,
  fill = false,
  style,
  testID = 'content-container',
}: ContentContainerProps): React.JSX.Element => (
  <View style={[styles.container, fill && styles.fill, style]} testID={testID}>
    {children}
  </View>
);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxWidth: contentLayout.maxWidth,
    alignSelf: 'center',
  },
  fill: {
    flex: 1,
  },
});

export default ContentContainer;
