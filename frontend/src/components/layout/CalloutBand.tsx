import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { accent, BORDER_RADIUS, rhythm, surface, touchTarget, uiType } from '@/design/tokens';

interface CalloutBandProps {
  /** The CTA label, rendered in inverted cream on the terracotta band. */
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * A full-bleed terracotta (`accent.primary`) callout band with an inverted cream
 * CTA (#826) — the app's single loudest accent moment, used scarcely. The cream
 * label (`surface.canvas`) clears WCAG AA on the accent ground. 44dp hit target;
 * no press animation, so it is reduced-motion-safe by construction.
 */
export const CalloutBand = ({
  label,
  onPress,
  accessibilityLabel,
  testID,
}: CalloutBandProps): React.JSX.Element => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    testID={testID}
    style={styles.band}
  >
    <Text style={styles.label}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  band: {
    minHeight: touchTarget.minimum,
    backgroundColor: accent.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: rhythm.blockGap,
    paddingHorizontal: rhythm.screenPaddingH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: surface.canvas, // cream on terracotta — 4.9:1 AA
    fontSize: uiType.button.fontSize,
    fontWeight: uiType.button.fontWeight,
  },
});
