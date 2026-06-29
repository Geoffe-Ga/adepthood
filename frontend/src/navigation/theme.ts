import { DefaultTheme, type Theme } from '@react-navigation/native';

import { accent, ink, surface } from '@/design/tokens';

/**
 * Warm "Candle & Ink" React Navigation theme (#803). Extends ``DefaultTheme``
 * (so v7's ``fonts`` block is inherited) and repaints the chrome colors from the
 * semantic tokens, so the persistent nav frame matches the warmed screens
 * instead of staying cold grey. Passed to ``NavigationContainer``.
 */
export const navTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    // React Navigation's color keys are opaque, so the only non-obvious part is
    // the mapping: primary drives the back arrow / header tint + active
    // affordances, card is the header + tab-bar ground, background is the screen
    // ground.
    primary: accent.primary,
    background: surface.canvas,
    card: surface.raised,
    text: ink.primary,
    border: surface.hairline,
    notification: accent.primary,
  },
};
