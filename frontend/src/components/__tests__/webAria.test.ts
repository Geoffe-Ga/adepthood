import { describe, it, expect, afterEach } from '@jest/globals';
import { Platform } from 'react-native';

import {
  webCheckedState,
  webDescribedBy,
  webDisabledState,
  webPressedState,
  webRadioState,
} from '../webAria';

const originalOS = Platform.OS;

function asPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => asPlatform(originalOS));

describe('webAria -- the states react-native-web cannot read from accessibilityState', () => {
  it('emits aria-checked and aria-disabled for a checkbox on the web', () => {
    asPlatform('web');
    expect(webCheckedState(true, false)).toEqual({ 'aria-checked': true, 'aria-disabled': false });
    expect(webCheckedState(false, true)).toEqual({ 'aria-checked': false, 'aria-disabled': true });
  });

  it('never emits aria-selected for a checkbox', () => {
    asPlatform('web');
    expect(webCheckedState(true, false)).not.toHaveProperty('aria-selected');
  });

  it('emits aria-disabled alone for a plain control on the web', () => {
    asPlatform('web');
    expect(webDisabledState(true)).toEqual({ 'aria-disabled': true });
  });

  it('emits nothing on native, where accessibilityState already carries each state', () => {
    asPlatform('ios');
    expect(webCheckedState(true, true)).toEqual({});
    expect(webDisabledState(true)).toEqual({});
    expect(webRadioState(true, false)).toEqual({});
    expect(webPressedState(true)).toEqual({});
    expect(webDescribedBy('x')).toEqual({});
  });

  it('keeps the existing helpers on the web', () => {
    asPlatform('web');
    expect(webRadioState(true, false)).toEqual({ 'aria-checked': true, 'aria-disabled': false });
    expect(webPressedState(false)).toEqual({ 'aria-pressed': false });
    expect(webDescribedBy('a b')).toEqual({ 'aria-describedby': 'a b' });
    expect(webDescribedBy('')).toEqual({});
  });
});
