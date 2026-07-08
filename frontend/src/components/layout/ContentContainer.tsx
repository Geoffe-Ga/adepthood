import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { contentLayout } from '@/design/tokens';

interface ContentContainerProps {
  children: React.ReactNode;
  /** Extra style merged onto the shared content-capped container. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The shared content-width cap: a full-width box centered and capped at
 * ``contentLayout.maxWidth`` so screen bodies settle on the same comfortable
 * reading measure on tablets and wide web instead of stretching edge-to-edge.
 * It uses ``flexGrow`` (not ``flex``) so it fills its parent, which holds when
 * the parent is a definite-height box or a scroll content container that itself
 * sets ``flexGrow`` — a scroll content container without its own grow leaves
 * this child at ~0 height on RN web. Callers wrap their scroll/flow body in
 * this; a caller ``style`` is merged on top without dropping the cap.
 */
export const ContentContainer = ({
  children,
  style,
  testID = 'content-container',
}: ContentContainerProps): React.JSX.Element => (
  <View style={[styles.container, style]} testID={testID}>
    {children}
  </View>
);

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    width: '100%',
    maxWidth: contentLayout.maxWidth,
    alignSelf: 'center',
  },
});

export default ContentContainer;
