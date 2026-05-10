/**
 * Single source of truth for all design tokens.
 *
 * Every color, spacing value, radius, shadow, and typography scale in the app
 * should be imported from this module. Do not define design constants elsewhere.
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  primary: '#1a1910',
  secondary: '#413d2f',
  success: '#535c46',
  warning: '#6c6b63',
  danger: '#7b3f30',
  // Slate-grey replacing #8c8c8c which fell at 3.07:1 against #f8f8f8 --
  // below WCAG 2.1 AA 4.5:1 for normal text (BUG-FE-UI-001). 4.93:1
  // brings the token over the threshold for body copy, captions, and
  // disabled-but-discernible UI states.
  neutral: '#6e6e6e',

  background: {
    primary: '#f8f8f8',
    card: '#ffffff',
    accent: '#f0f0f0',
  },

  text: {
    // WCAG 2.1 AA contrast ratios assume a primary background of #f8f8f8.
    //   primary     #333 / #f8f8f8 = 11.49 — pass AAA
    //   secondary   #666 / #f8f8f8 = 5.41  — pass AA normal, fail AAA
    //   tertiary    #999 / #f8f8f8 = 2.91  — fails AA normal (OK for large)
    //   light       #fff / dark BG — case-by-case
    // BUG-FRONTEND-INFRA-025: ``secondaryAccessible`` is the token to prefer
    // for body copy that needs AAA; legacy ``secondary`` remains for large
    // headings where AAA isn't required and the softer hue reads nicer.
    primary: '#333333',
    secondary: '#666666',
    secondaryAccessible: '#555555', // 7.22:1 on #f8f8f8 — AAA normal text
    tertiary: '#999999',
    tertiaryAccessible: '#707070', // 5.25:1 on #f8f8f8 — AA normal text
    light: '#ffffff',
  },

  mystical: {
    glowLight: 'rgba(255, 255, 255, 0.2)',
    glowPurple: 'rgba(103, 58, 183, 0.15)',
    overlay: 'rgba(0, 0, 0, 0.5)',
    transparentLight: 'rgba(255, 255, 255, 0.7)',
  },

  tier: {
    low: '#bc845d',
    clear: '#807f66',
    stretch: '#b0ae91',
    default: '#dad9d4',
  },

  // Surface variants for destructive + success banners. ``danger`` above is
  // the button-fill swatch; these are the softer banner/card treatments.
  destructive: {
    background: '#f8e0e0',
    border: '#e58a8a',
    text: '#b12828',
  },
  successText: '#2e7d32',

  border: '#ddd',

  /**
   * Bevel palette for recessed (sunken) controls. React Native has no
   * portable ``box-shadow: inset`` primitive, so depth is conveyed via the
   * classic two-tone bevel: a darker edge along the top + left of the
   * surface and a lighter edge along the bottom + right reads as a
   * depression. Used by the goal-target editor's input field; pair with
   * ``shadows.small`` on the saved-state chip for the convex counterpart.
   * Dark-mode equivalents will live alongside the rest of ``darkColors``
   * when that theme ships.
   */
  bevel: {
    recessedSurface: '#e9e9e9',
    edgeDark: '#bcbcbc',
    edgeLight: '#ffffff',
  },
} as const;

// ---------------------------------------------------------------------------
// Stage colors — maps stage name → hex color used across Habits and Map
// ---------------------------------------------------------------------------

/** Warm gold shown on progress bars when the user has met their clear goal. */
export const VICTORY_COLOR = '#c9a44c';

export const STAGE_COLORS: Record<string, string> = {
  Beige: '#d8cbb8',
  Purple: '#a093c6',
  Red: '#cc5b5b',
  Blue: '#6fa3d3',
  Orange: '#f29f67',
  Green: '#6fcf97',
  Yellow: '#f2e96d',
  Turquoise: '#50c9c3',
  Ultraviolet: '#8e44ad',
  'Clear Light': '#ffffff',
};

export const STAGE_ORDER: readonly string[] = [
  'Beige',
  'Purple',
  'Red',
  'Blue',
  'Orange',
  'Green',
  'Yellow',
  'Turquoise',
  'Ultraviolet',
  'Clear Light',
];

/** Colors for the map spiral visualization (indexed by stageNumber - 1). */
export const MAP_STAGE_COLORS = [
  '#7f1d1d',
  '#9f1239',
  '#c026d3',
  '#6d28d9',
  '#1d4ed8',
  '#0ea5e9',
  '#059669',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
] as const;

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

const BASE_SPACING = 8;

/** Fluid spacing function: returns `n * 8 * scale`. */
export const spacing = (n: number, scale = 1): number => n * BASE_SPACING * scale;

/** Named spacing constants for static layouts. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 30,
  // Vertical button padding -- 1px taller than ``md`` so a primary
  // button visually anchors over the surrounding text without
  // promoting to ``lg`` density everywhere.  Used by the auth
  // screens (Login, Signup, Forgot, Reset, CancelReset) for parity.
  buttonV: 14,
} as const;

// ---------------------------------------------------------------------------
// Border radius
// ---------------------------------------------------------------------------

/** Core radius values (used by DesignSystem consumers). */
export const radius = {
  sm: 4,
  md: 8,
  lg: 16,
} as const;

/** Extended radius scale for Habits UI components. */
export const BORDER_RADIUS = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 15,
  xxl: 30,
  circle: 9999,
} as const;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export const shadows = {
  small: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  large: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  glow: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Touch targets (BUG-FE-UI-002 / BUG-FE-UI-003)
// ---------------------------------------------------------------------------

/**
 * Minimum interactive surface size in dp.  WCAG 2.5.5 (Level AAA) and
 * Apple HIG / Material both put the floor at 44 dp; anything smaller
 * is a failure for users with motor impairments and inflates the
 * mistap rate on small phones across the board.  Shared primitives
 * (Button, IconButton, TouchableOpacity wrappers) MUST size their
 * hit-area to at least this value -- via ``minWidth`` /
 * ``minHeight`` on the touchable, or ``hitSlop`` when visual size
 * cannot grow.
 */
export const touchTarget = {
  minimum: 44,
} as const;

// ---------------------------------------------------------------------------
// Dark-mode palette (BUG-FE-UI-003)
// ---------------------------------------------------------------------------

/**
 * Dark-mode swatches.  Background / surface anchored to ``#121212``
 * (Material's recommended dark base) with elevation overlays that
 * already respect WCAG-AA contrast for the same text scale used in
 * the light palette.  Component adoption ships behind a follow-up
 * theme-context PR -- this module exports the values so the
 * downstream work has a single source of truth.
 */
export const darkColors = {
  background: {
    primary: '#121212',
    card: '#1e1e1e',
    accent: '#2a2a2a',
  },
  text: {
    // Contrast ratios on #121212:
    //   primary    #f5f5f5 / #121212 = 16.06 — pass AAA
    //   secondary  #b0b0b0 / #121212 = 8.59  — pass AAA
    //   tertiary   #8a8a8a / #121212 = 5.45  — pass AA normal
    //   light      #ffffff / dark BG — case-by-case
    primary: '#f5f5f5',
    secondary: '#b0b0b0',
    tertiary: '#8a8a8a',
    light: '#ffffff',
  },
  border: '#2f2f2f',
} as const;

export const breakpoints = { xs: 0, sm: 360, md: 600, lg: 900, xl: 1200 } as const;

export const elevation = {
  sm: 1,
  md: 3,
  lg: 6,
} as const;

/** Responsive font sizes based on viewport width. */
export const typography = (width: number) => {
  const base =
    width < breakpoints.sm
      ? 14
      : width < breakpoints.md
        ? 16
        : width < breakpoints.lg
          ? 18
          : width < breakpoints.xl
            ? 20
            : 22;
  return {
    title: base * 1.4,
    body: base,
    caption: base * 0.8,
  } as const;
};
