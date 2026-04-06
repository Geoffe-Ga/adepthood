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
  neutral: '#8c8c8c',

  background: {
    primary: '#f8f8f8',
    card: '#ffffff',
    accent: '#f0f0f0',
  },

  text: {
    primary: '#333333',
    secondary: '#666666',
    tertiary: '#999999',
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

  border: '#ddd',
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
