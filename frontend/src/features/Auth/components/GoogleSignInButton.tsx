import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  GOOGLE_BUTTON_LABEL,
  GOOGLE_BUTTON_STROKE_WIDTH,
  GOOGLE_BUTTON_THEMES,
  GOOGLE_BUTTON_TYPE,
  GOOGLE_LOGO_COLORS,
  GOOGLE_LOGO_SIZE,
  googleButtonPaddingFor,
} from './googleBranding';

import { Button } from '@/components/Button';
import { useTheme } from '@/design/ThemeContext';
import { BORDER_RADIUS } from '@/design/tokens';

/** The mark is decorative chrome; the button carries the accessible name. */
export const GOOGLE_LOGO_TEST_ID = 'social-auth-google-logo';

const [BLUE, GREEN, YELLOW, RED] = GOOGLE_LOGO_COLORS;

/**
 * The standard colour "G", as Google supplies it in their sign-in assets: one
 * quadrant per brand colour on a 48x48 grid. Reproduced as vector paths rather
 * than a bitmap so it stays crisp at every density, and left byte-for-byte
 * unrecoloured — a monochrome or restyled "G" is prohibited.
 */
const G_VIEWBOX = 48;
const G_QUADRANTS = [
  {
    fill: BLUE,
    d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
  },
  {
    fill: GREEN,
    d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
  },
  {
    fill: YELLOW,
    d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
  },
  {
    fill: RED,
    d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
  },
];

const PADDING = googleButtonPaddingFor(Platform.OS);

/**
 * Google's mark, boxed so the gap to the label is the mandated one.
 *
 * Hidden from assistive technology on both platforms: the button around it is
 * already named "Continue with Google", and a second announcement for the mark
 * would have a screen reader say the provider twice.
 */
function GoogleMark(): React.JSX.Element {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.mark}
      testID={GOOGLE_LOGO_TEST_ID}
    >
      <Svg
        width={GOOGLE_LOGO_SIZE}
        height={GOOGLE_LOGO_SIZE}
        viewBox={`0 0 ${G_VIEWBOX} ${G_VIEWBOX}`}
      >
        {G_QUADRANTS.map((quadrant) => (
          <Path key={quadrant.fill} d={quadrant.d} fill={quadrant.fill} />
        ))}
      </Svg>
    </View>
  );
}

interface GoogleSignInButtonProps {
  onPress: () => void;
  /** True while the credential exchange is in flight. */
  submitting: boolean;
  testID?: string;
}

/**
 * The "Continue with Google" button, drawn to Google's mandatory branding
 * guidelines.
 *
 * This is compliance, not decoration. Its fill, stroke, text colour, mark and
 * padding are Google's to specify, so it cannot and must not be styled into the
 * warm Candle & Ink language the rest of the auth screen speaks — the app's
 * ``secondary`` variant (terracotta outline on a raised surface) is a
 * substitution Google does not permit. The one thing that does track the app is
 * *which* approved theme is used: light mode takes Google's light theme, dark
 * mode Google's dark one, so the button stays legible on either canvas.
 *
 * Only three label strings are permitted, so the in-flight state cannot swap the
 * text for progress copy the way a house button would. The cue is carried by the
 * disabled dimming and ``accessibilityState.busy`` instead, and the mark stays
 * put throughout.
 *
 * Layout notes: the button stretches to the column width, so Google's
 * outer padding acts as the floor either side of the centred content rather than
 * as a shrink-to-fit measurement; the gap between mark and label is exact. The
 * shared primitive's 44dp minimum height is kept, and the corner radius matches
 * the Apple button directly below so the pair reads as one row. Google specifies
 * neither height nor radius, so both stay the app's to choose; everything Google
 * does specify is taken verbatim.
 */
export function GoogleSignInButton({
  onPress,
  submitting,
  testID,
}: GoogleSignInButtonProps): React.JSX.Element {
  const { mode } = useTheme();
  const theme = GOOGLE_BUTTON_THEMES[mode];

  return (
    <Button
      accessibilityLabel={GOOGLE_BUTTON_LABEL}
      busy={submitting}
      disabled={submitting}
      icon={<GoogleMark />}
      label={GOOGLE_BUTTON_LABEL}
      labelStyle={[styles.label, { color: theme.text }]}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.fill, borderColor: theme.stroke }]}
      testID={testID}
      // The unstyled variant: nothing of the design system's own fill or
      // outline to override, so what lands is exactly Google's.
      variant="tertiary"
    />
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: GOOGLE_BUTTON_STROKE_WIDTH,
    borderRadius: BORDER_RADIUS.lg,
    // Zeroed so Google's asymmetric left/right values are the only horizontal
    // padding in play, rather than layering over the primitive's symmetric one.
    paddingHorizontal: 0,
    paddingLeft: PADDING.beforeLogo,
    paddingRight: PADDING.afterText,
  },
  mark: { marginRight: PADDING.afterLogo },
  label: GOOGLE_BUTTON_TYPE,
});
