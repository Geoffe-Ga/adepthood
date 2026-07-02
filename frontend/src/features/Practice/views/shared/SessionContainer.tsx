import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';

import { useSessionSurface } from '../sessionSurface';

import { SESSION_CONTAINER } from './sessionStyles';

interface Props {
  testID: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** Centered session ground that paints the active surface's ground colour. */
export const SessionContainer = ({ testID, style, children }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  // Build conditionally so the no-override case emits no trailing undefined.
  const containerStyle = style
    ? [SESSION_CONTAINER, { backgroundColor: surface.ground }, style]
    : [SESSION_CONTAINER, { backgroundColor: surface.ground }];
  return (
    <View style={containerStyle} testID={testID}>
      {children}
    </View>
  );
};
