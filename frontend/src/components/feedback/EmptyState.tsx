/**
 * Editorial empty state: a warm centred glyph, a serif title, a lead body, and
 * an optional call-to-action slot. Replaces the bare one-line "nothing here yet"
 * text the Practice / Journal / Course screens each rolled by hand. Fades in via
 * ``useEntrance`` (static under reduced motion); token-only, AA on the canvas.
 *
 * Two layouts: the default full-screen centred surface, and a compact ``inline``
 * variant (transparent, non-expanding, no settle offset) for use as an in-list
 * block such as a ``SectionList`` footer, where the full-screen version would
 * overlap and cover neighbouring rows.
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
  /**
   * When ``true``, render as a compact, transparent, non-expanding block that
   * sits inline within a host list (e.g. a ``SectionList`` footer) rather than
   * as its own full-screen surface. Also suppresses the entrance's upward
   * settle so it doesn't read as floating over the content beneath it.
   *
   * Defaults to ``false``: the full-screen centered/opaque behavior the
   * Today / Course / Journal / Practice screens rely on is preserved untouched.
   */
  inline?: boolean;
  testID?: string;
}

export function EmptyState({
  glyph,
  title,
  body,
  cta,
  style,
  inline = false,
  testID = 'empty-state',
}: EmptyStateProps): React.JSX.Element {
  const t = type(useWindowDimensions().width);
  const entrance = useEntrance();
  // Inline keeps the opacity fade but drops the upward settle so it reads as
  // part of the list, not a surface floating in from below.
  const entranceStyle = inline ? { opacity: entrance.opacity } : entrance;
  return (
    <Animated.View
      style={[styles.container, inline && styles.inline, style, entranceStyle]}
      testID={testID}
    >
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
  inline: {
    flex: 0,
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    backgroundColor: 'transparent',
  },
  glyph: { fontSize: GLYPH_SIZE },
  title: { color: ink.primary, textAlign: 'center' },
  body: { color: ink.soft, textAlign: 'center' },
  cta: { marginTop: SPACING.sm },
});
