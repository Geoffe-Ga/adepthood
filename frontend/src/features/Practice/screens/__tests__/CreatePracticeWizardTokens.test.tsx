/* eslint-env jest */
// Candle & Ink token guards: wizard canvas, primary CTA, and selected stage chip pinned to their semantic token values.

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { PracticeItem, UserPractice } from '@/api';
import { accent, surface } from '@/design/tokens';
import type { ModeConfig } from '@/features/Practice/engine/types';

// Mirror the safe-area mock from the main wizard test so the canvas node is identical between both files.
jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

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

const { CreatePracticeWizard } = require('../CreatePracticeWizard');

interface NavMock {
  goBack: jest.Mock<() => void>;
  replace: jest.Mock<(...args: unknown[]) => void>;
  navigate: jest.Mock<(...args: unknown[]) => void>;
}

function makeNav(): NavMock {
  return {
    goBack: jest.fn() as jest.Mock<() => void>,
    replace: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
    navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
  };
}

interface RenderOptions {
  prefill?: {
    config: ModeConfig;
    name?: string;
    description?: string;
    instructions?: string;
    duration?: number;
    stageNumber?: number | null;
  };
}

function renderScreen(options: RenderOptions = {}, navOverride?: NavMock) {
  const navigation = navOverride ?? makeNav();
  const route = {
    key: 'k',
    name: 'CreatePractice' as const,
    params: options.prefill ? { prefill: options.prefill } : undefined,
  };
  const Screen = CreatePracticeWizard as unknown as React.ComponentType<{
    navigation: NavMock;
    route: typeof route;
  }>;
  const view = render(<Screen navigation={navigation} route={route} />);
  return { view, navigation };
}

// Navigates through mode picker and configurator to the metadata step (step 4) so stage chips and the submit button are visible.
function navigateToMetadata(navOverride?: NavMock) {
  const { view, navigation } = renderScreen({}, navOverride);
  fireEvent.press(view.getByTestId('create-practice-from-scratch'));
  fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
  fireEvent.press(view.getByTestId('create-practice-configure-next'));
  return { view, navigation };
}

// Helper: resolve a style array to a flat object (shared pattern with sessionSurfaceMigration/calmSurfaceMigration tests).
const flatBackground = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

// Guard 1: wizard canvas background resolves to surface.canvas (the migrated semantic token).
describe('Candle & Ink token guard — wizard canvas (create-practice-wizard)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('wizard canvas resolves to surface.canvas', () => {
    const { view } = renderScreen();
    const canvas = view.getByTestId('create-practice-wizard');
    expect(flatBackground(canvas.props.style)).toBe(surface.canvas);
  });
});

// Guard 2: primary CTA "Save practice" background resolves to accent.primary (the migrated semantic token).
describe('Candle & Ink token guard — primary CTA (create-practice-submit)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('submit button background resolves to accent.primary when enabled', () => {
    const { view } = navigateToMetadata();
    // Fill the name field so the button is enabled (not disabled-opaque); duration is pre-seeded for meditation_timer.
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Bell sit');
    const submit = view.getByTestId('create-practice-submit');
    expect(flatBackground(submit.props.style)).toBe(accent.primary);
  });
});

// Guard 3: selected stage chip resolves to accent.primary; an unselected chip must not.
describe('Candle & Ink token guard — selected stage chip (create-practice-stage-3)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('selected stage chip resolves to accent.primary background', () => {
    const { view } = navigateToMetadata();
    fireEvent.press(view.getByTestId('create-practice-stage-3'));
    const chip = view.getByTestId('create-practice-stage-3');
    expect(flatBackground(chip.props.style)).toBe(accent.primary);
  });

  it('unselected stage chip does not carry accent.primary background', () => {
    const { view } = navigateToMetadata();
    // Press stage-3 to select it; stage-5 remains unselected.
    fireEvent.press(view.getByTestId('create-practice-stage-3'));
    const unselected = view.getByTestId('create-practice-stage-5');
    expect(flatBackground(unselected.props.style)).not.toBe(accent.primary);
  });
});
