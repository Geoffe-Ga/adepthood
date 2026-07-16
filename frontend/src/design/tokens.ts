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
    secondaryAccessible: '#555555', // 7.02:1 on #f8f8f8 — AAA normal text
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
   * Dark-mode equivalents will live alongside the warm dark surface tokens
   * (``surfaceDark``) when the editor adopts that theme.
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
    // Promoted-quote wash — a warm apricot/blush, deliberately rosier than the
    // golden ``anchorHighlight`` so a promoted span reads as a distinct gesture
    // from a margin-note anchor. Ink (#2b2620) on it clears WCAG AA (~11.5:1).
    quoteHighlight: '#f7ddcb',
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
  Teal: '#50c9c3',
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
  'Teal',
  'Ultraviolet',
  'Clear Light',
];

// Pre-rename Spiral-Dynamics name for stage 8, mapped to its canonical name so
// a server still on the old dataset resolves to the Teal hex rather than the
// neutral-gray fallback.
const LEGACY_STAGE_ALIASES: Record<string, string> = {
  Turquoise: 'Teal',
};

/**
 * Resolve a Spiral-Dynamics color name to its hex value, falling back to the
 * neutral gray when the name is missing or unrecognized. This is the single
 * resolution used across the Course stage cover, progress bar, and pill
 * selector — keep it here so the fallback can never silently diverge.
 */
export const resolveStageColor = (spiralColor: string | undefined): string => {
  if (!spiralColor) {
    return colors.neutral;
  }
  const canonical = LEGACY_STAGE_ALIASES[spiralColor] ?? spiralColor;
  return STAGE_COLORS[canonical] ?? colors.neutral;
};

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

/**
 * Editorial screen rhythm (#825) — the single source of screen padding + section
 * gaps so every screen inherits Habits' composed feel. Derived from ``spacing``
 * (8px base); consumed by the layout primitives (ScreenScaffold / ScreenHeader /
 * EditorialSection).
 */
export const rhythm = {
  screenPaddingH: spacing(2), // 16 — horizontal page gutter
  screenPaddingTop: spacing(2), // 16 — top padding under the safe area
  sectionGap: spacing(3), // 24 — between editorial sections
  blockGap: spacing(1.5), // 12 — between blocks within a section
  heroPaddingV: spacing(3), // 24 — vertical breathing room around a screen header
} as const;

// ---------------------------------------------------------------------------
// Motion — shared durations + distance for the app-wide entrance/feedback
// vocabulary. Every consumer gates on ``useReducedMotion`` and falls back to the
// resting state, so this polish never costs accessibility.
// ---------------------------------------------------------------------------

export const motion = {
  fast: 90, // ms — press / quick feedback
  base: 220, // ms — entrance fade + settle, celebration pulse
  settleY: 6, // px — the small upward translate an element settles from
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
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  medium: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  large: {
    shadowColor: colors.paper.ink,
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

/** Habit-tile density in spacing UNITS (fed to `spacing(n, scale)`), not px. */
export const tileDensity = { paddingV: 0.5, barGap: 0.5 } as const;

/** WCAG-AA on the white modal card: #555 = 7.46:1 on #ffffff (AAA normal). */
export const CHART_AXIS_LABEL_COLOR = '#555555';

export const CHART_STYLE = {
  backgroundGradientFrom: '#ffffff',
  backgroundGradientFromOpacity: 0,
  backgroundGradientTo: '#ffffff',
  backgroundGradientToOpacity: 0,
  axisLineOpacity: 0.15,
} as const;

export const breakpoints = { xs: 0, sm: 360, md: 600, lg: 900, xl: 1200 } as const;

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
 * Shared reading-measure cap for full-width app screens. Derived from the
 * journal page's writing column plus its margin-notes gutter so every scaffolded
 * surface settles on the same comfortable measure on tablets and wide web,
 * instead of stretching content edge-to-edge. Kept as a derivation (not a bare
 * literal) so the cap tracks the journal metrics it is anchored to.
 */
export const contentLayout = {
  maxWidth: journalLayout.pageMaxWidth + journalLayout.marginColumnWidth,
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

// Clean system sans for chrome/body — no bundled font asset (same IP stance as
// the serif): the platform UI face on iOS, ``sans-serif`` on Android, a CSS
// stack on web. Resolved from ``Platform.OS`` to stay loadable under the repo's
// hand-rolled react-native mocks (see serif note above).
const sansByPlatform: Record<string, string> = {
  ios: 'System',
  android: 'sans-serif',
};
const sansStack =
  sansByPlatform[Platform.OS] ?? '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/**
 * Shared font stacks — the single source of truth for the app's faces. Only
 * platform-system fonts are used; no proprietary/commercial font files are
 * bundled, self-hosted, or embedded (see ``ATTRIBUTION``). ``editorialType``
 * (journal) and the app ``type`` ramp both draw their serif from ``serif``.
 */
export const fonts = {
  serif: serifStack,
  sans: sansStack,
} as const;

/**
 * WCAG-legibility floor (in dp) for tappable/interactive text. Companion to
 * ``touchTarget``: where ``touchTarget`` is the tap-AREA floor, this is the
 * floor for the text a reader is meant to tap or press, so an interactive label
 * reads as legible chrome rather than a fine-print footnote. The 13px caption
 * face sits below this floor and is metadata-only; interactive labels use
 * ``editorialType.action`` (and the ui button face) at this size instead.
 * Declared above ``editorialType`` and ``uiType`` so both can source it.
 */
export const INTERACTIVE_TEXT_MIN = 16;

export const editorialType = {
  serif: serifStack,
  display: { fontFamily: serifStack, fontSize: 34, lineHeight: 42, fontWeight: '700' as const },
  title: { fontFamily: serifStack, fontSize: 26, lineHeight: 34, fontWeight: '600' as const },
  body: { fontFamily: serifStack, fontSize: 18, lineHeight: 29, fontWeight: '400' as const },
  note: { fontFamily: serifStack, fontSize: 15, lineHeight: 24, fontWeight: '400' as const },
  caption: { fontFamily: serifStack, fontSize: 13, lineHeight: 20, fontWeight: '400' as const },
  // Interactive/tappable label face — serif to stay editorial, sized to the
  // interactive floor. caption is metadata-only and below the tappable floor.
  action: {
    fontFamily: serifStack,
    fontSize: INTERACTIVE_TEXT_MIN,
    lineHeight: 24,
    fontWeight: '600' as const,
  },
  marginNote: {
    fontFamily: serifStack,
    fontSize: 14,
    lineHeight: 21,
    fontStyle: 'italic' as const,
    fontWeight: '400' as const,
  },
} as const;

// ---------------------------------------------------------------------------
// App-wide editorial type ramp — serif display + clean-sans body (#800)
// ---------------------------------------------------------------------------

/**
 * The cohesive app type system: a serif display/heading face paired with a
 * clean system sans for body/labels (the journal keeps its all-serif
 * ``editorialType`` for long-form reading). Responsive-aware — sizes scale on
 * the same breakpoint base as :func:`typography`, so a phone reads tighter than
 * a tablet. Every face comes from :data:`fonts` (system only — no bundled font).
 */
export const type = (width: number) => {
  const base =
    width < breakpoints.sm
      ? 15
      : width < breakpoints.md
        ? 16
        : width < breakpoints.lg
          ? 17
          : width < breakpoints.xl
            ? 18
            : 19;
  const serif = (size: number, weight: '600' | '700') => ({
    fontFamily: fonts.serif,
    fontSize: size,
    lineHeight: Math.round(size * 1.25),
    fontWeight: weight,
  });
  const sans = (size: number, weight: '400' | '600') => ({
    fontFamily: fonts.sans,
    fontSize: size,
    lineHeight: Math.round(size * 1.5),
    fontWeight: weight,
  });
  return {
    display: serif(Math.round(base * 2.1), '700'),
    title: serif(Math.round(base * 1.6), '600'),
    heading: serif(Math.round(base * 1.25), '600'),
    body: sans(base, '400'),
    label: sans(Math.round(base * 0.9), '600'),
    caption: sans(Math.round(base * 0.8), '400'),
  } as const;
};

// ---------------------------------------------------------------------------
// UI typography — non-editorial chrome (buttons, chips) in the system stack
// ---------------------------------------------------------------------------

/** Typography for interactive chrome, so button/label sizing lives in tokens. */
export const uiType = {
  button: { fontSize: INTERACTIVE_TEXT_MIN, fontWeight: '600' as const },
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

// ---------------------------------------------------------------------------
// Semantic app-wide layer — the "Candle & Ink" warm-editorial language (#798)
// ---------------------------------------------------------------------------

/**
 * App-wide warm grounds. Derived from the existing paper palette so the whole
 * app reads as paper-on-desk rather than flat grey chrome. The legacy
 * ``background``/``surface`` greys remain for un-migrated screens but are no
 * longer the design default.
 */
export const surface = {
  canvas: colors.paper.background, // #faf6ef — the app ground
  raised: '#ffffff', // lifted cards / sheets
  sunken: colors.paper.backgroundAlt, // #f3ecdf — recessed wells
  desk: colors.paper.desk, // #e7dcc8 — the deeper ground a sheet floats above
  hairline: colors.paper.hairline, // #e3dccd — faint warm rule
} as const;

/**
 * Ink scale for text on ``surface.canvas``. Every value clears WCAG AA
 * (>= 4.5:1) on the canvas ground — asserted in ``semanticTokens.test.ts``.
 */
export const ink = {
  primary: colors.paper.ink, // #2b2620 — 13.9:1 (AAA)
  soft: colors.paper.inkSoft, // #5a5046 — 7.3:1 (AAA)
  muted: '#6b6055', // 5.7:1 — captions / placeholders
} as const;

/**
 * Original terracotta / sienna accent, darkened from ``colors.tier.clear``
 * (#be6e46, a graphical-only ~3:1 swatch) so the accent clears AA as text on
 * the canvas. Not any brand's swatch — see ``ATTRIBUTION``.
 */
export const accent = {
  primary: '#a5572f', // 4.9:1 on canvas
  strong: '#8f4a28', // 6.1:1 — pressed / emphasis
  onPrimary: '#ffffff', // light foreground on the accent fill (white on terracotta ~5:1, AA)
} as const;

/**
 * App-wide warm elevation — the generalisation of ``paperShadow`` beyond the
 * journal. Ink-tinted, downward; iOS/web use the shadow* props, Android uses
 * ``elevation``. ``paperShadow`` stays as-is for the journal's contracts.
 */
export const surfaceShadow = {
  card: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  raised: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 6,
  },
} as const;

// ---------------------------------------------------------------------------
// Warm dark mode — the candlelit counterpart of the light language (#804)
// ---------------------------------------------------------------------------

/**
 * Warm dark grounds — deep umber/charcoal, NOT Material's neutral ``#121212``,
 * so the dark theme reads as candlelit paper rather than a black slab. Mirrors
 * the light ``surface`` shape; ``raised`` is lighter than ``canvas`` (a lifted
 * sheet) and ``desk`` is the deepest ground.
 */
export const surfaceDark = {
  canvas: '#1c1814', // the dark app ground (warm umber)
  raised: '#272019', // lifted cards / sheets — a step lighter
  sunken: '#15110d', // recessed wells — a step darker
  desk: '#120e0b', // the deepest ground a sheet floats above
  hairline: '#3a3026', // faint warm rule on the dark ground
} as const;

/**
 * Warm off-white ink for ``surfaceDark.canvas``. Every value clears WCAG AA
 * (>= 4.5:1) on the dark canvas — asserted in ``semanticTokensDark.test.ts``.
 */
export const inkDark = {
  primary: '#f3ece0', // 15.0:1 (AAA)
  soft: '#cdbfae', // 9.8:1 (AAA)
  muted: '#a89880', // 6.3:1 — captions / placeholders
} as const;

/**
 * Terracotta accent for dark mode — brightened from the light ``accent`` so it
 * clears AA as text on the dark canvas (a dark ground needs a lighter accent).
 */
export const accentDark = {
  primary: '#e0895a', // 6.6:1 on the dark canvas
  strong: '#eaa078', // 8.2:1 — pressed / emphasis
  onPrimary: surfaceDark.canvas, // dark ink foreground on the light dark-mode accent fill (~6.6:1, AA)
} as const;

/**
 * Dark elevation. Shadows read faintly on dark grounds, so the lift leans on a
 * near-black warm shadow at higher opacity plus the same Android elevations.
 */
export const surfaceShadowDark = {
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 3,
  },
  raised: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 6,
  },
} as const;

// ---------------------------------------------------------------------------
// Showcase surfaces — a warm-dark "designed product" band on a light screen
// ---------------------------------------------------------------------------

/**
 * Deep warm-umber showcase ground for hero moments on an otherwise light screen
 * (Today #828, the Practice player #831, the Course cover #832, the Map
 * celebration #833). An original derivation of the app's own warm ink — a brown
 * umber (red channel above blue), NOT navy and NOT Material's ``#121212``. See
 * ``ATTRIBUTION``.
 */
export const showcase = {
  canvas: '#2a211a', // the umber band ground
  raised: '#352a20', // a lifted step within the band
} as const;

/**
 * Ink for text on ``showcase.canvas``. Every value clears WCAG AA (>= 4.5:1) on
 * the umber ground — asserted in ``showcaseTokens.test.ts``.
 */
export const onShowcase = {
  primary: '#f3ece0', // 13.4:1 — warm off-white
  soft: '#cdbfae', // 8.8:1
  muted: '#a8967c', // 5.5:1 — captions
} as const;

/**
 * Elevation for a showcase band lifting off a light screen — ink-tinted,
 * downward; iOS/web shadow* props + Android ``elevation``.
 */
export const showcaseShadow = {
  shadowColor: colors.paper.ink,
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.18,
  shadowRadius: 22,
  elevation: 8,
} as const;
