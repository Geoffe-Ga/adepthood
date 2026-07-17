import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { rhythm, surface } from '@/design/tokens';

/**
 * A sibling overlay that dissolves the bottom edge of a scroll surface into the
 * canvas ground, so long content appears to fade out rather than clip at a hard
 * line. The transparent stop is `surface.canvas` at zero opacity, not black --
 * a black-to-opaque ramp prints a visible grey mid-fringe on the warm ground,
 * while fading between two stops of the same color is invisible until the
 * opacity itself takes over. It renders as an absolutely-positioned sibling of
 * the ScrollView, never as a scroll child, so the ScrollView's own
 * `contentContainerStyle` keeps sole ownership of the height/grow contract
 * that makes native scrolling work. It is `pointerEvents="none"` so it never
 * intercepts taps on the controls it overlaps.
 *
 * The veil is a fixed `rhythm.bottomFadeHeight` tall, pinned to its container's
 * bottom edge; its opaque `surface.canvas` base blends seamlessly into whatever
 * ground sits below -- the physical screen bottom (where it covers the home
 * indicator zone) or a bottom safe-area region (where a `SafeAreaView` has
 * already inset the content). A fixed height keeps the fade consistent across
 * both layouts instead of double-counting the inset. Callers pad the scroller's
 * content by `rhythm.bottomFadeHeight` (see `ScreenScaffold`'s `scrollContent`
 * style) so the veil only ever covers already-read trailing whitespace, never
 * the last line of real content.
 */
export const BottomFade = ({ testID = 'bottom-fade' }: { testID?: string }): React.JSX.Element => (
  <View pointerEvents="none" style={styles.overlay} testID={testID}>
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id="bottom-fade-grad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={surface.canvas} stopOpacity="0" />
          <Stop offset="1" stopColor={surface.canvas} stopOpacity="1" />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#bottom-fade-grad)" />
    </Svg>
  </View>
);

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: rhythm.bottomFadeHeight,
  },
});

export default BottomFade;
