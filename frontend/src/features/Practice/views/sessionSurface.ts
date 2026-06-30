/**
 * Colour context for the in-session ritual views (#831).
 *
 * The mode views (`MeditationTimerView`, `RepCounterView`, …) historically
 * hard-coded the light `colors.*` palette in their static `StyleSheet`s, so a
 * meditation session read like a settings form. To put a *running* session on
 * the warm-dark `showcase` ground without rewriting every view's layout, each
 * view reads its text / cue / ring colours from this context and appends them as
 * inline overrides on top of its existing styles.
 *
 * The default value is the original light palette, so any view rendered WITHOUT
 * a provider (e.g. the idle selector, existing unit tests) is byte-for-byte
 * unchanged. `ActiveRitualSession` wraps the live session in
 * {@link SessionSurfaceProvider} with {@link SHOWCASE_SURFACE} to flip the whole
 * mode view onto the umber ground with AA-clearing `onShowcase` cues.
 */
import { createContext, useContext } from 'react';

import { colors, onShowcase, showcase } from '@/design/tokens';

export interface SessionSurface {
  /** The ground the session renders on. */
  ground: string;
  /** A lifted panel within the ground (cards, rings' fill). */
  raised: string;
  /** Primary reading colour (timer digits, headings). */
  text: string;
  /** Secondary copy (labels, captions). */
  textSoft: string;
  /** De-emphasised copy (hints). */
  textMuted: string;
  /** Accent / progress-ring stroke / cue highlight. */
  accent: string;
}

/** The original light palette — the default so non-session views are unchanged. */
export const LIGHT_SURFACE: SessionSurface = {
  ground: colors.background.primary,
  raised: colors.background.card,
  text: colors.text.primary,
  textSoft: colors.text.secondary,
  textMuted: colors.text.tertiary,
  accent: colors.success,
};

/** The warm-dark showcase palette for a running session (AA on the umber). */
export const SHOWCASE_SURFACE: SessionSurface = {
  ground: showcase.canvas,
  raised: showcase.raised,
  text: onShowcase.primary,
  textSoft: onShowcase.soft,
  textMuted: onShowcase.muted,
  accent: onShowcase.primary,
};

const SessionSurfaceContext = createContext<SessionSurface>(LIGHT_SURFACE);

export const SessionSurfaceProvider = SessionSurfaceContext.Provider;

/** Read the active session surface; defaults to the light palette. */
export function useSessionSurface(): SessionSurface {
  return useContext(SessionSurfaceContext);
}
