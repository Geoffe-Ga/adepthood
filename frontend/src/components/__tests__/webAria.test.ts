import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { Platform } from 'react-native';

import {
  webCheckedState,
  webDescribedBy,
  webDisabledState,
  webPressedState,
  webRadioState,
  webRadioSpace,
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

interface RadioKeyboardCapture {
  onKeyDownCapture: (_event: {
    key: string;
    repeat: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void;
}

function keyEvent(key: string, repeat = false) {
  return { key, repeat, preventDefault: jest.fn(), stopPropagation: jest.fn() };
}

describe('web radio Space activation', () => {
  it.each([' ', 'Spacebar'])('selects once with %s and prevents page scrolling', (key) => {
    asPlatform('web');
    const activate = jest.fn();
    const event = keyEvent(key);
    webRadioSpace<RadioKeyboardCapture>(false, activate).onKeyDownCapture!(event);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it.each(['Enter', 'Escape'])('leaves %s to the existing native-web responder', (key) => {
    asPlatform('web');
    const activate = jest.fn();
    const event = keyEvent(key);
    webRadioSpace<RadioKeyboardCapture>(false, activate).onKeyDownCapture!(event);
    expect(activate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores auto-repeat activation while still preventing Space scrolling', () => {
    asPlatform('web');
    const activate = jest.fn();
    const event = keyEvent(' ', true);
    webRadioSpace<RadioKeyboardCapture>(false, activate).onKeyDownCapture!(event);
    expect(activate).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('never activates a disabled option', () => {
    asPlatform('web');
    const activate = jest.fn();
    webRadioSpace<RadioKeyboardCapture>(true, activate).onKeyDownCapture!(keyEvent(' '));
    expect(activate).not.toHaveBeenCalled();
  });

  it('adds no keyboard props to native radio options', () => {
    asPlatform('ios');
    expect(webRadioSpace(false, jest.fn())).toEqual({});
  });
});
