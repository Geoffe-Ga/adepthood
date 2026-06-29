/**
 * Single source of truth for all design tokens.
 *
 * Every color, spacing value, radius, shadow, and typography scale in the app
 * should be imported from this module. Do not define design constants elsewhere.
 */

import { Platform } from 'react-native';

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

  // Goal-tier palette — "Candle & Ink". A warm, literary analogous arc
  // (brass → terracotta → garnet) that deepens in saturation and value
  // toward the more ambitious tier, so Low → Clear → Stretch reads as a
  // single coherent progression rather than three unrelated earth tones.
  // Replaces the muted aptitude.guru swatches (#bc845d / #807f66 / #b0ae91),
  // whose middle tier was darker than both neighbors and so broke the
  // visual ordering.
  tier: {
    // Low brass darkened from #c9a66b to clear WCAG 2.1 SC 1.4.11 (3:1 for
    // graphical objects): #b08d40 is ~3.1:1 on white vs the prior ~2.3:1.
    low: '#b08d40', // warm old-gold / brass
    clear: '#be6e46', // terracotta / sienna
    stretch: '#8c3b2e', // deep garnet / ember
    default: '#dad9d4',
  },

  // Medal palette for the Map goal badges — deliberately the classic
  // bronze/silver/gold (distinct from the `tier` palette above, which is the
  // app's literary earth-tone arc). Keyed by goal tier: low→bronze, clear→silver,
  // stretch→gold.
  medal: {
    bronze: '#cd7f32',
    silver: '#c0c0c0',
    gold: '#ffd700',
  },

  // Goal-tier star markers are tier-agnostic greyscale: a darkish-grey outline
  // while the tier is unmet, then a greyscale gradient fill with a white border
  // glow once the tier is achieved.
  starMarker: {
    outline: '#555555', // darkish-grey outline (unmet) — AAA on #f8f8f8
    gradientFrom: '#9c9c9c', // light end of the met greyscale fill
    gradientTo: '#3a3a3a', // dark end of the met greyscale fill
    glow: '#ffffff', // white border glow on the met star
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
  // Hairline separator between stacked rows/sections. Same value as
  // ``background.accent`` (which it replaced as a divider colour) — a clearer
  // name so a ``borderBottomColor`` reads as a divider, not a reused background.
  separator: '#f0f0f0',

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

  /**
   * Warm editorial palette for the journal-resonance surface only. A paper-like
   * off-white ground with dark ink, a faint rule, and a soft anchor highlight.
   * Contrast on the primary ground (#faf6ef):
   *   ink     #2b2620 = 13.9:1 — AAA
   *   inkSoft #5a5046 =  7.3:1 — AAA
   * The anchor highlight is a background wash (text keeps its own ink colour).
   */
  paper: {
    background: '#faf6ef',
    backgroundAlt: '#f3ecdf',
    // The deeper, warmer "desk" the writing sheet floats above — a step darker
    // than `background` so the lighter sheet reads as lifted (the warm
    // `paperShadow` below carries the rest of the depth cue).
    desk: '#e7dcc8',
    // Faint lit edge for the lifted sheet — slightly lighter than `hairline` so
    // the sheet border reads as a paper edge, not a divider.
    sheetEdge: '#efe7d8',
    ink: '#2b2620',
    inkSoft: '#5a5046',
    hairline: '#e3dccd',
    anchorHighlight: '#f0e3c2',
  },

  /**
   * Subtle accent per margin-note kind. Used for the kind dot / rule beside a
   * note; each clears AA as text on the paper ground (>= 4.5:1 on #faf6ef).
   */
  marginalia: {
    theme: '#8a6a2f',
    connection: '#4f6173',
    symbol: '#7a4f63',
  },
} as const;

// ---------------------------------------------------------------------------
// Stage colors — maps stage name → hex color used across Habits and Map
// ---------------------------------------------------------------------------

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

/** How far each channel is pushed from the gray point when brightening. */
const SATURATION_BOOST = 1.7;

const clampChannel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

const parseHexRgb = (hex: string): [number, number, number] | null => {
  const match = /^#([\da-f]{6})$/i.exec(hex);
  if (!match) return null;
  const digits = match[1]!;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
};

const toHexColor = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => clampChannel(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Return a more vivid shade of a hex color by pushing each channel away
 * from the color's gray point. Used for the goal-met progress bar so the
 * victory state is a brighter version of the habit's own stage color
 * rather than a flat gold. Achromatic inputs (e.g. the white "Clear Light"
 * stage) have no hue to intensify and are returned unchanged; inputs that
 * are not 6-digit hex are likewise passed through untouched.
 */
export const brightenColor = (hex: string): string => {
  const rgb = parseHexRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  const gray = (r + g + b) / 3;
  return toHexColor(
    gray + (r - gray) * SATURATION_BOOST,
    gray + (g - gray) * SATURATION_BOOST,
    gray + (b - gray) * SATURATION_BOOST,
  );
};

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

/** WCAG-AA on the white modal card: #555 = 7.22:1 on #ffffff (AAA normal). */
export const CHART_AXIS_LABEL_COLOR = '#555555';

export const CHART_STYLE = {
  backgroundGradientFrom: '#ffffff',
  backgroundGradientFromOpacity: 0,
  backgroundGradientTo: '#ffffff',
  backgroundGradientToOpacity: 0,
  axisLineOpacity: 0.15,
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

// ---------------------------------------------------------------------------
// Editorial / journal-resonance tokens (additive — journal surface only)
// ---------------------------------------------------------------------------

/**
 * Layout metrics for the two-column journal page (writing column + margin
 * notes). ``marginColumnWidth`` is the fixed gutter the margin notes occupy;
 * ``pageMaxWidth`` keeps the reading measure comfortable on tablets.
 */
export const journalLayout = {
  marginColumnWidth: 220,
  pageHorizontalPadding: 24,
  pageMaxWidth: 680,
  marginNoteGap: 16,
} as const;

/**
 * Warm, long-form serif typography for the journal surface. Uses the platform
 * serif stack (no bundled font asset): Georgia on iOS, the system ``serif``
 * family on Android, and a CSS-style stack on web. Line-heights are generous
 * (~1.6 on body) for a calm reading rhythm.
 *
 * Resolved from ``Platform.OS`` (not ``Platform.select``) at module load: this
 * file is imported app-wide, and the repo's hand-rolled ``react-native`` test
 * mocks expose ``Platform.OS`` but not ``Platform.select`` — keeping the tokens
 * module loadable under every mock.
 */
const serifByPlatform: Record<string, string> = {
  ios: 'Georgia',
  android: 'serif',
};
const serifStack = serifByPlatform[Platform.OS] ?? 'Georgia, "Times New Roman", serif';

export const editorialType = {
  serif: serifStack,
  display: { fontFamily: serifStack, fontSize: 34, lineHeight: 42, fontWeight: '700' as const },
  title: { fontFamily: serifStack, fontSize: 26, lineHeight: 34, fontWeight: '600' as const },
  body: { fontFamily: serifStack, fontSize: 18, lineHeight: 29, fontWeight: '400' as const },
  note: { fontFamily: serifStack, fontSize: 15, lineHeight: 24, fontWeight: '400' as const },
  caption: { fontFamily: serifStack, fontSize: 13, lineHeight: 20, fontWeight: '400' as const },
  marginNote: {
    fontFamily: serifStack,
    fontSize: 14,
    lineHeight: 21,
    fontStyle: 'italic' as const,
    fontWeight: '400' as const,
  },
} as const;

// ---------------------------------------------------------------------------
// UI typography — non-editorial chrome (buttons, chips) in the system stack
// ---------------------------------------------------------------------------

/** Typography for interactive chrome, so button/label sizing lives in tokens. */
export const uiType = {
  button: { fontSize: 16, fontWeight: '600' as const },
} as const;

// ---------------------------------------------------------------------------
// Editorial elevation — depth primitives for the floating journal page
// ---------------------------------------------------------------------------

/**
 * Soft, warm, downward shadows for lifting paper surfaces (the journal sheet,
 * shelf cards, margin notes) off the desk ground. Ink-tinted rather than pure
 * black so the lift reads as paper-on-desk, not card-on-glass. iOS/web use the
 * shadow* props; Android uses `elevation`.
 */
export const paperShadow = {
  sheet: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 6,
  },
  card: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
} as const;

/** Metrics for the floated journal sheet (the depth issues consume these). */
export const journalSheet = {
  cornerRadius: radius.lg, // rounded top of the lifted sheet
  deskPaddingH: spacing(2), // desk visible left/right of the sheet
  deskPaddingTop: spacing(1.5), // desk visible above the sheet
} as const;
