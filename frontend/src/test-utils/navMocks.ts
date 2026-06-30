/**
 * Shared React Navigation test doubles.
 *
 * App.tsx builds `navTheme` by spreading `DefaultTheme`, so any test that mounts
 * App must expose `DefaultTheme` from its `@react-navigation/native` mock or the
 * theme module throws at load. This is the single source for that stub so a
 * future RN-Navigation shape change is a one-line update (was duplicated inline
 * across App-importing test mocks — #803 review).
 */
export const mockDefaultTheme = {
  dark: false,
  colors: {
    primary: '#000000',
    background: '#ffffff',
    card: '#ffffff',
    text: '#000000',
    border: '#cccccc',
    notification: '#000000',
  },
  fonts: {},
} as const;

/**
 * Dark counterpart — `navThemeDark` spreads `DarkTheme`, so any App-importing
 * test mock must expose it too (#804).
 */
export const mockDarkTheme = {
  dark: true,
  colors: {
    primary: '#ffffff',
    background: '#000000',
    card: '#000000',
    text: '#ffffff',
    border: '#333333',
    notification: '#ffffff',
  },
  fonts: {},
} as const;
