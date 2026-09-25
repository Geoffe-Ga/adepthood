import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { editorPrimaryModifier } from '../editorPrimaryModifier';

const Platform = require('react-native').Platform as { OS: string };

describe('editorPrimaryModifier', () => {
  let originalOS: string;
  let originalNavigator: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalOS = Platform.OS;
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  });
  afterEach(() => {
    Platform.OS = originalOS;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });

  function browse(navigator: { platform?: string; userAgent?: string } | undefined) {
    Platform.OS = 'web';
    Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  }

  it.each([
    ['ios', 'meta'],
    ['macos', 'meta'],
    ['android', 'ctrl'],
    ['windows', 'ctrl'],
  ])('uses the platform convention on %s', (os, expected) => {
    Platform.OS = os;
    expect(editorPrimaryModifier()).toBe(expected);
  });

  it.each([
    [{ platform: 'MacIntel' }, 'meta'],
    [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }, 'meta'],
    [{ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'ctrl'],
    [{ platform: 'Win32' }, 'ctrl'],
    [undefined, 'ctrl'],
  ])('reads a browser on %j as %s', (navigator, expected) => {
    browse(navigator);
    expect(editorPrimaryModifier()).toBe(expected);
  });
});
