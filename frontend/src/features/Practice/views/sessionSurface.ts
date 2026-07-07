/**
 * Colour context for the in-session ritual views.
 *
 * The mode views (`MeditationTimerView`, `RepCounterView`, …) keep their static
 * `StyleSheet`s and read their text / cue / ring colours from this context,
 * appending them as inline overrides on top of those styles. This lets a
 * running session take surface-colour overrides without rewriting each view's
 * layout.
 *
 * The default value is {@link LIGHT_SURFACE}, so any view rendered WITHOUT a
 * provider (e.g. the idle selector, existing unit tests) is byte-for-byte
 * unchanged. `ActiveRitualSession` wraps the live session in
 * {@link SessionSurfaceProvider} with {@link CALM_SURFACE} to skin the whole
 * mode view onto lifted white paper with AA-clearing `ink.*` cues.
 */
import { createContext, useContext } from 'react';

import { accent, colors, ink, surface } from '@/design/tokens';

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

/**
 * The default light palette — used so non-session (no-provider) views are
 * unchanged.
 *
 * `textSoft` / `textMuted` map to the *Accessible* text tokens because that is
 * what the mode views' static `StyleSheet`s already used (the AA-tuned
 * `*Accessible` variants, not the legacy `secondary` / `tertiary`). Mapping them
 * here keeps the no-provider render byte-for-byte identical to the static light
 * styles.
 */
export const LIGHT_SURFACE: SessionSurface = {
  ground: colors.background.primary,
  raised: colors.background.card,
  text: colors.text.primary,
  textSoft: colors.text.secondaryAccessible,
  textMuted: colors.text.tertiaryAccessible,
  accent: colors.success,
};

/**
 * The calm lifted-paper session surface — a running session rests on white
 * `surface.raised` with the AA-clearing `ink.*` scale, recessed `surface.sunken`
 * wells, and the terracotta `accent.primary`. The deep umber `showcase` ground
 * is reserved for the single Begin hero accent, so a running practice reads as
 * quiet lifted paper rather than a third stacked umber band.
 */
export const CALM_SURFACE: SessionSurface = {
  ground: surface.raised,
  raised: surface.sunken,
  text: ink.primary,
  textSoft: ink.soft,
  textMuted: ink.muted,
  accent: accent.primary,
};

const SessionSurfaceContext = createContext<SessionSurface>(LIGHT_SURFACE);

export const SessionSurfaceProvider = SessionSurfaceContext.Provider;

/** Read the active session surface; defaults to the light palette. */
export function useSessionSurface(): SessionSurface {
  return useContext(SessionSurfaceContext);
}
