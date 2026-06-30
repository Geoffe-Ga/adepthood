import React, { createContext, useContext, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import type { ViewStyle } from 'react-native';

import {
  accent,
  accentDark,
  ink,
  inkDark,
  surface,
  surfaceDark,
  surfaceShadow,
  surfaceShadowDark,
} from './tokens';

export type ThemeMode = 'light' | 'dark';

/** The resolved token set for the active mode. Shapes mirror the light tokens. */
export interface ThemeTokens {
  mode: ThemeMode;
  surface: Record<keyof typeof surface, string>;
  ink: Record<keyof typeof ink, string>;
  accent: Record<keyof typeof accent, string>;
  surfaceShadow: { card: ViewStyle; raised: ViewStyle };
}

export interface ThemeContextValue extends ThemeTokens {
  setMode: (mode: ThemeMode) => void;
}

const LIGHT_TOKENS: ThemeTokens = { mode: 'light', surface, ink, accent, surfaceShadow };
const DARK_TOKENS: ThemeTokens = {
  mode: 'dark',
  surface: surfaceDark,
  ink: inkDark,
  accent: accentDark,
  surfaceShadow: surfaceShadowDark,
};

/** Resolve the token set for a mode. Exported so the nav theme can reuse it. */
export const themeTokensFor = (mode: ThemeMode): ThemeTokens =>
  mode === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;

// Default to the light set with a no-op setter, so components calling
// ``useTheme()`` outside a provider (e.g. the many screen tests) resolve the
// light language without needing a wrapper.
const ThemeContext = createContext<ThemeContextValue>({ ...LIGHT_TOKENS, setMode: () => {} });

/** The system color scheme at mount, mapped to a mode (defaults to light). */
const initialSystemMode = (): ThemeMode =>
  Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';

interface ThemeProviderProps {
  children: React.ReactNode;
  /** Force a mode (tests / explicit override); otherwise follows the system. */
  initialMode?: ThemeMode;
}

/**
 * Provides the warm-mode token set. Initialises from the system color scheme
 * (overridable via ``initialMode``); ``setMode`` reskins the tree by swapping
 * the resolved tokens without touching layout or testIDs (#804).
 */
export const ThemeProvider = ({ children, initialMode }: ThemeProviderProps): React.JSX.Element => {
  const [mode, setMode] = useState<ThemeMode>(initialMode ?? initialSystemMode());
  const value = useMemo<ThemeContextValue>(() => ({ ...themeTokensFor(mode), setMode }), [mode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

/** Resolve the active theme tokens (light when outside a provider). */
export const useTheme = (): ThemeContextValue => useContext(ThemeContext);
