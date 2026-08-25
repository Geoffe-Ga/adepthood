/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));

/** Viewport the mocked dimensions hook reports; changed per test. */
let mockViewportWidth = 1440;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockViewportWidth, height: 900, scale: 1, fontScale: 1 }),
}));

import { WELCOME_PANELS } from '../welcomeContent';
import { WelcomeScreen } from '../WelcomeScreen';

import { contentLayout } from '@/design/tokens';

/** A laptop browser: far wider than the shared content cap. */
const WIDE_VIEWPORT = 1440;
/** A phone: narrower than the cap, so the cap must not change anything. */
const PHONE_VIEWPORT = 390;

const setup = () => {
  const onComplete = jest.fn();
  return { onComplete, ...render(<WelcomeScreen onComplete={onComplete} />) };
};

/** The resolved style of a rendered element, with its style array flattened. */
const flatStyle = (element: { props: { style?: StyleProp<ViewStyle> } }): ViewStyle =>
  StyleSheet.flatten(element.props.style) ?? {};

const flatWidth = (element: { props: { style?: StyleProp<ViewStyle> } }): ViewStyle['width'] =>
  flatStyle(element).width;

/** Page the walkthrough by scrolling `stride` px per panel, as the pager does. */
const scrollToPanel = (
  getByTestId: ReturnType<typeof render>['getByTestId'],
  index: number,
  stride: number,
) => {
  fireEvent(getByTestId('welcome-pager'), 'momentumScrollEnd', {
    nativeEvent: {
      contentOffset: { x: index * stride },
      layoutMeasurement: { width: stride },
    },
  });
};

beforeEach(() => {
  mockViewportWidth = WIDE_VIEWPORT;
});

// ---------------------------------------------------------------------------
// The cap the rest of the app already uses
// ---------------------------------------------------------------------------

describe('WelcomeScreen on a wide viewport', () => {
  it('caps the walkthrough column at the shared content width', () => {
    const { getByTestId } = setup();
    expect(flatWidth(getByTestId('welcome-column'))).toBe(contentLayout.maxWidth);
  });

  it('centres that column so the margins are symmetric', () => {
    const { getByTestId } = setup();
    expect(flatStyle(getByTestId('welcome-column')).alignSelf).toBe('center');
  });

  it('sizes every panel to the capped width, not the raw viewport', () => {
    const { getByTestId } = setup();
    WELCOME_PANELS.forEach((_, index) => {
      expect(flatWidth(getByTestId(`welcome-panel-${index}`))).toBe(contentLayout.maxWidth);
    });
  });
});

// ---------------------------------------------------------------------------
// Panel width, offset -> page and scrollTo must agree on one number
// ---------------------------------------------------------------------------

describe('WelcomeScreen paging on a wide viewport', () => {
  it('resolves the last panel from a stride of one capped width per page', () => {
    const { getByTestId } = setup();
    scrollToPanel(getByTestId, WELCOME_PANELS.length - 1, contentLayout.maxWidth);
    expect(getByTestId('welcome-begin')).toBeTruthy();
  });

  it('does not resolve a page from a stride of one raw viewport per page', () => {
    // The desynchronised arithmetic this guards against: were the offset still
    // divided by the uncapped viewport width, this is the scroll position that
    // would land on the final panel, and the capped pager must not read it that way.
    const { getByTestId, queryByTestId } = setup();
    scrollToPanel(getByTestId, WELCOME_PANELS.length - 1, WIDE_VIEWPORT);
    expect(queryByTestId('welcome-begin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phones are below the cap, so nothing about them may change
// ---------------------------------------------------------------------------

describe('WelcomeScreen on a phone viewport', () => {
  it('fills the viewport, uncapped', () => {
    mockViewportWidth = PHONE_VIEWPORT;
    const { getByTestId } = setup();
    expect(flatWidth(getByTestId('welcome-column'))).toBe(PHONE_VIEWPORT);
    expect(flatWidth(getByTestId('welcome-panel-0'))).toBe(PHONE_VIEWPORT);
  });

  it('still pages on the viewport stride', () => {
    mockViewportWidth = PHONE_VIEWPORT;
    const { getByTestId } = setup();
    scrollToPanel(getByTestId, WELCOME_PANELS.length - 1, PHONE_VIEWPORT);
    expect(getByTestId('welcome-begin')).toBeTruthy();
  });
});
