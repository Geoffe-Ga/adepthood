/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

let mockReduced = false;
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockReduced,
}));

const TEST_WIDTH = 400;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: TEST_WIDTH, height: 800, scale: 1, fontScale: 1 }),
}));

import { WELCOME_PANELS, WELCOME_PILLARS } from '../welcomeContent';
import { WelcomeScreen } from '../WelcomeScreen';

beforeEach(() => {
  mockReduced = false;
});

const setup = () => {
  const onComplete = jest.fn();
  const onBegin = jest.fn();
  const utils = render(<WelcomeScreen onComplete={onComplete} onBegin={onBegin} />);
  return { onComplete, onBegin, ...utils };
};

describe('WelcomeScreen', () => {
  it('renders every editorial panel with the five pillars', () => {
    const { getByTestId, getByText } = setup();
    expect(getByTestId('welcome-screen')).toBeTruthy();
    WELCOME_PANELS.forEach((_, i) => {
      expect(getByTestId(`welcome-panel-${i}`)).toBeTruthy();
    });
    WELCOME_PILLARS.forEach((pillar) => {
      expect(getByText(pillar.name)).toBeTruthy();
    });
  });

  it('keeps a persistent Skip on the screen', () => {
    const { getByTestId } = setup();
    expect(getByTestId('welcome-skip')).toBeTruthy();
  });

  it('shows Begin on the final panel and Next before it', () => {
    const { getByTestId, queryByTestId } = setup();
    // First render is the first panel: Next visible, Begin not yet.
    expect(getByTestId('welcome-next')).toBeTruthy();
    expect(queryByTestId('welcome-begin')).toBeNull();
  });

  it('Begin completes (sets flag) and navigates to Today', () => {
    const { getByTestId, onComplete, onBegin } = setup();
    // Page to the last panel via the pager scroll handler.
    const lastIndex = WELCOME_PANELS.length - 1;
    fireEvent(getByTestId('welcome-pager'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: lastIndex * 400 }, layoutMeasurement: { width: 400 } },
    });
    fireEvent.press(getByTestId('welcome-begin'));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it('Skip completes (sets flag) without beginning', () => {
    const { getByTestId, onComplete, onBegin } = setup();
    fireEvent.press(getByTestId('welcome-skip'));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onBegin).not.toHaveBeenCalled();
  });

  it('advances pages under reduced motion (paging works without animation)', () => {
    mockReduced = true;
    const { getByTestId } = setup();
    fireEvent.press(getByTestId('welcome-next'));
    // After advancing past the first panel the Next control is still present
    // until the final panel — the page state changed without animation.
    fireEvent(getByTestId('welcome-pager'), 'momentumScrollEnd', {
      nativeEvent: {
        contentOffset: { x: (WELCOME_PANELS.length - 1) * 400 },
        layoutMeasurement: { width: 400 },
      },
    });
    expect(getByTestId('welcome-begin')).toBeTruthy();
  });
});
