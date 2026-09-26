import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Platform } from 'react-native';
import type { View } from 'react-native';

/**
 * ``moveAccessibilityFocus`` hands focus to a control that just appeared, so a
 * keyboard or screen-reader user is not dropped at the top of the document when
 * the control they pressed unmounts (#2862: the care note's X).
 */
import { moveAccessibilityFocus } from '../accessibilityFocus';

const NODE_HANDLE = 7;

jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...(jest.requireActual('react-native/Libraries/ReactNative/RendererProxy') as object),
  findNodeHandle: jest.fn((target: unknown) => (target === null ? null : NODE_HANDLE)),
}));

const originalOS = Platform.OS;

function setOS(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function fakeTarget(): { target: View; focus: jest.Mock } {
  const focus = jest.fn();
  return { target: { focus } as unknown as View, focus };
}

afterEach(() => {
  setOS(originalOS);
  jest.restoreAllMocks();
});

describe('moveAccessibilityFocus', () => {
  it('moves screen-reader focus to the target on native', () => {
    setOS('ios');
    const setFocus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    const { target, focus } = fakeTarget();

    moveAccessibilityFocus(target);

    expect(setFocus).toHaveBeenCalledWith(NODE_HANDLE);
    expect(focus).not.toHaveBeenCalled();
  });

  it('focuses the DOM element on web', () => {
    setOS('web');
    const setFocus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    const { target, focus } = fakeTarget();

    moveAccessibilityFocus(target);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('focuses a separate web target when one is given, never the native one', () => {
    setOS('web');
    const native = fakeTarget();
    const web = fakeTarget();

    moveAccessibilityFocus(native.target, web.target);

    expect(web.focus).toHaveBeenCalledTimes(1);
    expect(native.focus).not.toHaveBeenCalled();
  });

  it('uses the native target on native even when a web target is given', () => {
    setOS('android');
    const setFocus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    const web = fakeTarget();

    moveAccessibilityFocus(fakeTarget().target, web.target);

    expect(setFocus).toHaveBeenCalledWith(NODE_HANDLE);
    expect(web.focus).not.toHaveBeenCalled();
  });

  it('does nothing when the target has not mounted', () => {
    setOS('android');
    const setFocus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);

    moveAccessibilityFocus(null);

    expect(setFocus).not.toHaveBeenCalled();
  });
});
