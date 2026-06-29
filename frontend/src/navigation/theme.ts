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
    primary: accent.primary, // back/tint + active affordances
    background: surface.canvas, // screen ground behind navigators
    card: surface.raised, // headers + tab bar ground
    text: ink.primary,
    border: surface.hairline,
    notification: accent.primary,
  },
};
