import { afterEach, describe, expect, it } from '@jest/globals';
import { Platform } from 'react-native';

import { decorativeHidden, EXPOSE_SUBTREE, HIDE_SUBTREE } from '../a11yHidden';

const originalOS = Platform.OS;

function asPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => asPlatform(originalOS));

/** The props react-native-web forwards to the DOM unfiltered on a react-native-svg element. */
const NATIVE_ONLY_KEYS = ['accessible', 'accessibilityElementsHidden', 'importantForAccessibility'];

describe('decorativeHidden -- one spelling that hides on native and on the web (#3009, #2829)', () => {
  it('names the two Android values it chooses between', () => {
    expect(HIDE_SUBTREE).toBe('no-hide-descendants');
    expect(EXPOSE_SUBTREE).toBe('auto');
  });

  it.each(['ios', 'android'] as const)(
    'hides from every reader on %s, aria-hidden included',
    (os) => {
      asPlatform(os);
      expect(decorativeHidden()).toEqual({
        'aria-hidden': true,
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      });
      expect(decorativeHidden(true)).toEqual(decorativeHidden());
    },
  );

  it.each(['ios', 'android'] as const)(
    'exposes the subtree again on %s without un-grouping it (no accessible key)',
    (os) => {
      asPlatform(os);
      const shown = decorativeHidden(false);
      expect(shown).toEqual({
        'aria-hidden': false,
        accessibilityElementsHidden: false,
        importantForAccessibility: 'auto',
      });
      expect(shown).not.toHaveProperty('accessible');
    },
  );

  it('is exactly aria-hidden on the web, where the native-only props would reach the DOM', () => {
    asPlatform('web');
    expect(decorativeHidden()).toEqual({ 'aria-hidden': true });
    expect(decorativeHidden(false)).toEqual({ 'aria-hidden': false });
    for (const key of NATIVE_ONLY_KEYS) {
      expect(decorativeHidden()).not.toHaveProperty(key);
      expect(decorativeHidden(false)).not.toHaveProperty(key);
    }
  });

  it('returns a fresh object each call, so a spread site cannot mutate another', () => {
    asPlatform('ios');
    expect(decorativeHidden()).not.toBe(decorativeHidden());
  });
});
