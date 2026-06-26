/* eslint-env jest */
// audit-ux-02: end-to-end check that the real SafeAreaProvider feeds device
// insets into a Practice full-screen surface. Per-screen inset coverage (via a
// stubbed useSafeAreaInsets) lives in each screen's own suite; this proves the
// provider → useSafeAreaInsets → padding chain with the real provider, so it
// would catch the provider being unmounted from the tree.
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// This suite deliberately exercises the REAL provider → useSafeAreaInsets chain,
// so opt out of the global jest.setup safe-area mock for this file only.
jest.unmock('react-native-safe-area-context');

import type { PracticeItem, UserPractice } from '@/api';

const mockPracticesCreate = jest.fn();
const mockUserPracticesCreate = jest.fn();

jest.mock('@/api', () => ({
  practices: {
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

const { CreatePracticeWizard } = require('../screens/CreatePracticeWizard');

// A fixed inset frame the real SafeAreaProvider exposes to its subtree, standing
// in for a notched device (no native measurement happens in tests).
const INITIAL_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, bottom: 34, left: 0, right: 0 },
};

const nav = {
  goBack: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
};
const route = { key: 'k', name: 'CreatePractice' as const, params: undefined };

describe('Practice safe-area integration (real provider)', () => {
  it('feeds provider insets into the wizard surface without throwing', () => {
    const Screen = CreatePracticeWizard as unknown as React.ComponentType<{
      navigation: typeof nav;
      route: typeof route;
    }>;
    const { getByTestId } = render(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <Screen navigation={nav} route={route} />
      </SafeAreaProvider>,
    );
    // Renders (no "no safe area value" throw) and applies the provider's insets.
    expect(getByTestId('create-practice-step-entry')).toBeTruthy();
    expect(getByTestId('create-practice-wizard')).toHaveStyle({
      paddingTop: 47,
      paddingBottom: 34,
    });
  });
});
