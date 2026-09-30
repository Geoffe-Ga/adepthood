import { expect, jest } from '@jest/globals';
import type { render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

type Screen = Pick<ReturnType<typeof render>, 'queryByText' | 'queryAllByRole'>;

/**
 * Assert that a screen whose stack header paints ``title`` leaves the title to
 * navigation (#2962): the body neither paints it nor carries a header node
 * named by it. The stack header is the screen's one title heading; a second,
 * even an invisible one, would announce the title twice. That count across the
 * whole page is held in a browser by
 * ``e2e/screen-title-heading.browser.e2e.test.ts``; Jest renders no navigator,
 * so this is the body's half of it.
 */
export function expectNavigationOwnsTitle(screen: Screen, title: string): void {
  expect(screen.queryByText(title)).toBeNull();
  expect(screen.queryAllByRole('header', { name: title })).toHaveLength(0);
}

/**
 * Watch both ways a screen can move screen-reader focus, so a test can pin
 * that opening it moves none (#2962: dropping the painted title must not
 * start moving focus). Call ``expectNone`` after the screen settles.
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
