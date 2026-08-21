import type { ThemeMode } from '@/design/ThemeContext';
import { googleBrand } from '@/design/tokens';

/**
 * Google's mandatory "Sign in with Google" branding constants.
 *
 * Everything in this file is transcribed from
 * https://developers.google.com/identity/branding-guidelines, which Google
 * publishes as a requirement — not a suggestion — for any app using their
 * identity service. Several of the properties this app would otherwise reach
 * for are explicitly prohibited: a monochrome "G", a custom icon, and the
 * standard colour "G" on any fill other than the three below.
 *
 * These values therefore deliberately do NOT come from the Candle & Ink design
 * tokens, and must not be "harmonised" with them later. They live apart from
 * the design system for exactly that reason: the design system is ours to
 * evolve, and this button is not.
 */

/**
 * Google permits exactly three phrases: "Sign in with Google", "Sign up with
 * Google", and "Continue with Google" (localisation allowed). We use the third,
 * because this one control both signs in and signs up.
 */
export const GOOGLE_BUTTON_LABEL = 'Continue with Google';

/** Fill / stroke / text for one approved theme. */
export interface GoogleButtonTheme {
  fill: string;
  stroke: string;
  text: string;
}

/**
 * The two approved themes this app can use, keyed by the app's own theme mode.
 *
 * Google publishes three — light, dark, and a neutral `#F2F2F2` with no
 * stroke. The neutral theme is omitted rather than exported unused: the app has
 * exactly two modes, and mapping each to Google's same-named theme is what keeps
 * the button legible against whichever canvas is behind it.
 */
export const GOOGLE_BUTTON_THEMES: Record<ThemeMode, GoogleButtonTheme> = {
  light: {
    fill: googleBrand.lightFill,
    stroke: googleBrand.lightStroke,
    text: googleBrand.lightText,
  },
  dark: { fill: googleBrand.darkFill, stroke: googleBrand.darkStroke, text: googleBrand.darkText },
};

/** "1px inside" per the guidelines — a hairline would be a substitution. */
export const GOOGLE_BUTTON_STROKE_WIDTH = 1;

/**
 * The mandated 14/20 label metrics.
 *
 * Google specifies Google Sans Medium. That family is not bundled here and
 * pulling in a whole font file for one control is a cost the app does not carry,
 * so the family is a knowing, documented deviation: the platform UI face at
 * Google's size, weight and leading. Size and leading are honoured exactly,
 * including where 14 sits below the app's own ``INTERACTIVE_TEXT_MIN`` floor —
 * on this one button Google's figure wins, and the 44dp tap target does not
 * shrink with it.
 */
export const GOOGLE_BUTTON_TYPE = { fontSize: 14, lineHeight: 20, fontWeight: '500' } as const;

/** Horizontal padding, which Google specifies per platform. */
export interface GoogleButtonPadding {
  beforeLogo: number;
  afterLogo: number;
  afterText: number;
}

const IOS_PADDING: GoogleButtonPadding = { beforeLogo: 16, afterLogo: 12, afterText: 16 };
const ANDROID_WEB_PADDING: GoogleButtonPadding = { beforeLogo: 12, afterLogo: 10, afterText: 12 };

/**
 * The padding triple for a platform: 16/12/16 on iOS, 12/10/12 on Android and
 * web. Takes the OS as an argument rather than reading ``Platform.OS`` so both
 * rows of the table stay reachable from a test on either platform.
 */
export const googleButtonPaddingFor = (os: string): GoogleButtonPadding =>
  os === 'ios' ? IOS_PADDING : ANDROID_WEB_PADDING;

/**
 * The four brand colours of the standard colour "G". Exported so the guard
 * against a monochrome or recoloured mark can assert on the palette itself
 * rather than on path data.
 */
export const GOOGLE_LOGO_COLORS = [
  googleBrand.logoBlue,
  googleBrand.logoGreen,
  googleBrand.logoYellow,
  googleBrand.logoRed,
] as const;

/**
 * Google does not specify the mark's size, the button height, or its corner
 * radius. 18dp matches the proportions of the mark in Google's own supplied
 * button assets; height and radius are left to the shared primitive, which
 * clears 44dp and matches the adjacent Apple button's corner.
 */
export const GOOGLE_LOGO_SIZE = 18;
