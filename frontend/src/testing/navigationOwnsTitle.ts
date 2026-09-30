import { expect, jest } from '@jest/globals';
import type { render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

type Screen = Pick<ReturnType<typeof render>, 'queryByText' | 'getAllByRole'>;

/**
 * Assert that a screen whose stack header paints ``title`` does not paint it
 * again in its body, and keeps exactly one header node named by it (#2962).
 *
 * The node wraps nothing (so the eyebrow, lead or warning beside it reads as
 * ordinary text) and is not a focus target. A screen rendered outside a
 * navigator has no stack header, so in a Jest tree that node is the screen's
 * one accessible title.
 */
export function expectNavigationOwnsTitle(screen: Screen, title: string): void {
  expect(screen.queryByText(title)).toBeNull();
  const hosts = screen.getAllByRole('header', { name: title });
  expect(hosts).toHaveLength(1);
  const [host] = hosts;
  expect(host?.props.children).toBeUndefined();
  expect(host?.props.accessibilityHint).toBeUndefined();
  expect(host?.props.tabIndex).toBeUndefined();
  expect(host?.props.focusable).toBeUndefined();
}

/**
 * Watch both ways a screen can move screen-reader focus, so a test can pin
 * that opening it moves none (#2962: dropping the painted title must not
 * start focusing the header). Call ``expectNone`` after the screen settles.
 */
export function watchFocusMoves(): { expectNone: () => void } {
  const setFocus = jest
    .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
    .mockImplementation(() => undefined);
  const sendEvent = jest
    .spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
    .mockImplementation(() => undefined);
  return {
    expectNone: () => {
      expect(setFocus).not.toHaveBeenCalled();
      expect(sendEvent).not.toHaveBeenCalled();
      setFocus.mockRestore();
      sendEvent.mockRestore();
    },
  };
}
