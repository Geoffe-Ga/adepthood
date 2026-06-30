/**
 * Editorial empty state: a warm centred glyph, a serif title, a lead body, and
 * an optional call-to-action slot. Replaces the bare one-line "nothing here yet"
 * text the Practice / Journal / Course screens each rolled by hand. Fades in via
 * ``useEntrance`` (static under reduced motion); token-only, AA on the canvas.
 */
import React from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ink, rhythm, SPACING, surface, type } from '@/design/tokens';
import { useEntrance } from '@/hooks/useEntrance';

const GLYPH_SIZE = 48;

interface EmptyStateProps {
  glyph: string;
  title: string;
  body: string;
  /** Optional action (e.g. a Button) rendered under the body. */
  cta?: React.ReactNode;
  /** Extra container style — e.g. safe-area insets from the host screen. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  glyph,
  title,
  body,
  cta,
  style,
  testID = 'empty-state',
}: EmptyStateProps): React.JSX.Element {
  const t = type(useWindowDimensions().width);
  const entrance = useEntrance();
  return (
    <Animated.View style={[styles.container, style, entrance]} testID={testID}>
      <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
        {glyph}
      </Text>
      <Text style={[t.title, styles.title]} accessibilityRole="header">
        {title}
      </Text>
      <Text style={[t.body, styles.body]}>{body}</Text>
      {cta ? <View style={styles.cta}>{cta}</View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: rhythm.screenPaddingH,
    gap: rhythm.blockGap,
    backgroundColor: surface.canvas,
  },
  glyph: { fontSize: GLYPH_SIZE },
  title: { color: ink.primary, textAlign: 'center' },
  body: { color: ink.soft, textAlign: 'center' },
  cta: { marginTop: SPACING.sm },
});
