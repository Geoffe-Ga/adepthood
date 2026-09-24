/**
 * Whether the live Markdown mirror draws over the body field.
 *
 * Web only: the mirror is laid out under a real ``<textarea>`` whose glyphs go
 * transparent, and web is the one platform where that alignment is measured
 * (the Playwright geometry probe). Native keeps its visible ``TextInput``.
 *
 * Off under ``forced-colors``: Windows High Contrast forces the textarea's
 * glyphs visible again, and the mirror under them would draw every word twice.
 */
import { useState } from 'react';
import { Platform } from 'react-native';

/** The media query a forced-colors (high contrast) mode matches. */
export const FORCED_COLORS_QUERY = '(forced-colors: active)';

interface MediaQueryHost {
  matchMedia?: (query: string) => { matches: boolean };
}

function forcedColorsActive(): boolean {
  const host = (globalThis as { window?: MediaQueryHost }).window;
  if (host == null || typeof host.matchMedia !== 'function') return false;
  return host.matchMedia(FORCED_COLORS_QUERY).matches;
}

/** Read once per mount: a writer switching contrast modes mid-page reopens it. */
export function useLiveMirrorEnabled(): boolean {
  const [forced] = useState(forcedColorsActive);
  return Platform.OS === 'web' && !forced;
}
