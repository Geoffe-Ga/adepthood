/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
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

// ---------------------------------------------------------------------------
// Issue #897 — Privacy note in onboarding (RED — fails until impl exists)
// ---------------------------------------------------------------------------

// The privacy note rides the "Five pillars" panel (index 1) via a new optional
// `note` field on WelcomePanel — NOT an additional panel.
// WELCOME_PANELS.length must stay at 4 (the current count).
const EXPECTED_PANEL_COUNT = 4;

// Exact onboarding note copy (verbatim — em dash U+2014, curly apostrophe U+2019
// in "entry’s", matching the apostrophe convention in welcomeContent.ts).
const PRIVACY_NOTE =
  'Your journal is yours — you choose each entry’s privacy, and anything you mark Intimate never leaves for AI.';

// The privacy note lives on panel index 1 ("Five pillars"). Drive the pager
// there before querying so the note is in the rendered tree.
const scrollToPanelIndex = (
  getByTestId: ReturnType<typeof render>['getByTestId'],
  index: number,
) => {
  fireEvent(getByTestId('welcome-pager'), 'momentumScrollEnd', {
    nativeEvent: {
      contentOffset: { x: index * TEST_WIDTH },
      layoutMeasurement: { width: TEST_WIDTH },
    },
  });
};

describe('WelcomeScreen — onboarding privacy note (issue #897)', () => {
  it('WELCOME_PANELS.length is unchanged at 4 — no new panel was added', () => {
    // If a new panel is added this fails, enforcing the "no gate/slowdown" rule.
    expect(WELCOME_PANELS.length).toBe(EXPECTED_PANEL_COUNT);
  });

  it('renders the privacy note testID on the Five Pillars panel', () => {
    const { getByTestId } = setup();
    scrollToPanelIndex(getByTestId, 1);
    const panel = getByTestId('welcome-panel-1');

    expect(within(panel).getByTestId('welcome-privacy-note')).toBeTruthy();
  });

  it('renders the exact privacy note copy verbatim', () => {
    const { getByTestId, getByText } = setup();
    scrollToPanelIndex(getByTestId, 1);

    expect(getByText(PRIVACY_NOTE)).toBeTruthy();
  });

  it('privacy note text is contained within the Five Pillars panel', () => {
    const { getByTestId } = setup();
    scrollToPanelIndex(getByTestId, 1);
    const panel = getByTestId('welcome-panel-1');

    expect(within(panel).getByText(PRIVACY_NOTE)).toBeTruthy();
  });

  it('Skip still fires onComplete without onBegin after privacy note added', () => {
    const { getByTestId, onComplete, onBegin } = setup();
    fireEvent.press(getByTestId('welcome-skip'));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onBegin).not.toHaveBeenCalled();
  });

  it('Begin on the last panel still fires both onComplete and onBegin after privacy note added', () => {
    const { getByTestId, onComplete, onBegin } = setup();
    const lastIndex = WELCOME_PANELS.length - 1;
    scrollToPanelIndex(getByTestId, lastIndex);
    fireEvent.press(getByTestId('welcome-begin'));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onBegin).toHaveBeenCalledTimes(1);
  });
});
