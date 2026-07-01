/* eslint-env jest */
/**
 * Candle & Ink token-consumption guards for the practice authoring flow.
 *
 * Each assertion names the semantic token value imported directly from
 * `@/design/tokens` and pins that the migrated node resolves to it, with a
 * negative pin against the legacy value it replaced.
 *
 * Covered nodes:
 *   1. Wizard canvas (`create-practice-wizard`) → surface.canvas
 *   2. Primary CTA (`create-practice-submit`) → accent.primary
 *   3. Selected stage chip (`create-practice-stage-3`) → accent.primary
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { PracticeItem, UserPractice } from '@/api';
import { accent, colors, surface } from '@/design/tokens';
import type { ModeConfig } from '@/features/Practice/engine/types';

// Mirror the safe-area mock from the main wizard test so the canvas node is
// identical between both files.
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

// Navigates through mode picker and configurator to the metadata step (step 4)
// so stage chips and the submit button are visible.
function navigateToMetadata(navOverride?: NavMock) {
  const { view, navigation } = renderScreen({}, navOverride);
  fireEvent.press(view.getByTestId('create-practice-from-scratch'));
  fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
  fireEvent.press(view.getByTestId('create-practice-configure-next'));
  return { view, navigation };
}

// ---------------------------------------------------------------------------
// Helpers — resolve a style array to a flat object (same pattern used in
// sessionSurfaceMigration.test.tsx and calmSurfaceMigration.test.tsx).
// ---------------------------------------------------------------------------

const flatBackground = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

// ---------------------------------------------------------------------------
// Guard 1: Wizard canvas background → surface.canvas
// Legacy value guarded against: styles.screen uses `colors.background.primary` (#f8f8f8).
// ---------------------------------------------------------------------------

describe('Candle & Ink token guard — wizard canvas (create-practice-wizard)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('wizard canvas resolves to surface.canvas, not the legacy background.primary', () => {
    const { view } = renderScreen();
    const canvas = view.getByTestId('create-practice-wizard');
    // POST-migration expected value — the migrated semantic token value.
    expect(flatBackground(canvas.props.style)).toBe(surface.canvas);
  });

  it('wizard canvas does NOT use the legacy colors.background.primary value', () => {
    const { view } = renderScreen();
    const canvas = view.getByTestId('create-practice-wizard');
    // Negative pin — stays valid even if surface.canvas === colors.background.primary
    // were ever (wrongly) equated.
    expect(flatBackground(canvas.props.style)).not.toBe(colors.background.primary);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: Primary CTA "Save practice" background → accent.primary
// Legacy value guarded against: styles.primaryButton uses `colors.primary` (#1a1910).
// The button carries `[styles.primaryButton, nextDisabled && styles.disabledButton]`;
// flatten resolves the array to a single style object.
// ---------------------------------------------------------------------------

describe('Candle & Ink token guard — primary CTA (create-practice-submit)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('submit button background resolves to accent.primary when enabled', () => {
    const { view } = navigateToMetadata();
    // Fill the name field so the button is enabled (not disabled-opaque).
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Bell sit');
    // Also need a valid duration — the configured default is auto-set, but
    // the form validation requires duration > 0; set it explicitly.
    fireEvent.changeText(view.getByTestId('create-practice-duration'), '20');
    const submit = view.getByTestId('create-practice-submit');
    // POST-migration expected value — the migrated semantic token value.
    expect(flatBackground(submit.props.style)).toBe(accent.primary);
  });

  it('submit button does NOT use the legacy colors.primary near-black', () => {
    const { view } = navigateToMetadata();
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Bell sit');
    fireEvent.changeText(view.getByTestId('create-practice-duration'), '20');
    const submit = view.getByTestId('create-practice-submit');
    expect(flatBackground(submit.props.style)).not.toBe(colors.primary);
  });
});

// ---------------------------------------------------------------------------
// Guard 3: Selected stage chip background → accent.primary
// Unselected chip must NOT carry accent.primary.
// Legacy value guarded against: stageChipSelected uses `colors.primary` (#1a1910).
// ---------------------------------------------------------------------------

describe('Candle & Ink token guard — selected stage chip (create-practice-stage-3)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('selected stage chip resolves to accent.primary background', () => {
    const { view } = navigateToMetadata();
    fireEvent.press(view.getByTestId('create-practice-stage-3'));
    const chip = view.getByTestId('create-practice-stage-3');
    // POST-migration expected value — the migrated semantic token value.
    expect(flatBackground(chip.props.style)).toBe(accent.primary);
  });

  it('unselected stage chip does not carry accent.primary background', () => {
    const { view } = navigateToMetadata();
    // Press stage-3 to select it; stage-5 remains unselected.
    fireEvent.press(view.getByTestId('create-practice-stage-3'));
    const unselected = view.getByTestId('create-practice-stage-5');
    expect(flatBackground(unselected.props.style)).not.toBe(accent.primary);
  });

  it('selected stage chip does NOT use the legacy colors.primary near-black', () => {
    const { view } = navigateToMetadata();
    fireEvent.press(view.getByTestId('create-practice-stage-3'));
    const chip = view.getByTestId('create-practice-stage-3');
    expect(flatBackground(chip.props.style)).not.toBe(colors.primary);
  });
});
