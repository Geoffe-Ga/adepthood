import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

import {
  spacing,
  SPACING,
  touchTarget,
  tileDensity,
  BOTTOM_TAB_BAR_CONTENT_HEIGHT,
} from '../../../design/tokens';
import type { Habit } from '../Habits.types';
import { useTileLayout, HabitTile } from '../HabitTile';

const TOTAL_HABITS = 10;

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const mockWindowDimensions = (width: number, height: number): void => {
  jest
    .spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width, height, scale: 1, fontScale: 1 });
};

// Probe renders the hook's return into testID'd Text so tests can read it back.
const TileLayoutProbe = (): React.JSX.Element => {
  const { tileMinHeight, gridGutter, scale } = useTileLayout();
  return (
    <>
      <Text testID="probe-tile-min-height">{tileMinHeight}</Text>
      <Text testID="probe-grid-gutter">{gridGutter}</Text>
      <Text testID="probe-scale">{scale}</Text>
    </>
  );
};

interface TileLayoutSnapshot {
  tileMinHeight: number;
  gridGutter: number;
  scale: number;
}

const renderTileLayout = (insets: Insets): TileLayoutSnapshot => {
  const { getByTestId } = render(
    <SafeAreaInsetsContext.Provider value={insets}>
      <TileLayoutProbe />
    </SafeAreaInsetsContext.Provider>,
  );
  const tileMinHeight = Number(getByTestId('probe-tile-min-height').props.children);
  const gridGutter = Number(getByTestId('probe-grid-gutter').props.children);
  const scale = Number(getByTestId('probe-scale').props.children);
  return { tileMinHeight, gridGutter, scale };
};

// Mirrors the icon-row/header-row/section-gap chrome the implementation reserves per screen.
const computeChrome = (scale: number, gridGutter: number): number =>
  2 * spacing(1, scale) + spacing(3, scale) + 2 * spacing(1, scale) + SPACING.sm + gridGutter;

describe('useTileLayout fit invariant', () => {
  it('keeps the full 10-tile stack within the viewport height budget', () => {
    mockWindowDimensions(390, 844);
    const insets: Insets = { top: 47, bottom: 34, left: 0, right: 0 };
    const { tileMinHeight, gridGutter, scale } = renderTileLayout(insets);

    expect(tileMinHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    // Concrete expected density at the target profile: a chrome-model drift or a
    // token change breaks this independently of the reconstructed budget below.
    const EXPECTED_TILE_MIN_HEIGHT = 57;
    expect(tileMinHeight).toBe(EXPECTED_TILE_MIN_HEIGHT);

    const chrome = computeChrome(scale, gridGutter);
    const bottomBarReserve = BOTTOM_TAB_BAR_CONTENT_HEIGHT + insets.bottom;
    const stackHeight = TOTAL_HABITS * (tileMinHeight + gridGutter);
    const totalHeight = stackHeight + insets.top + bottomBarReserve + chrome;

    expect(totalHeight).toBeLessThanOrEqual(844);
  });

  it('clamps tileMinHeight to the touch-target floor on a short viewport', () => {
    mockWindowDimensions(390, 500);
    const insets: Insets = { top: 20, bottom: 0, left: 0, right: 0 };
    const { tileMinHeight } = renderTileLayout(insets);

    expect(tileMinHeight).toBe(touchTarget.minimum);
  });
});

describe('HabitTile density pass', () => {
  const width = 390;
  const height = 844;
  const scale = 0.9;

  const baseHabit: Habit = {
    id: 1,
    stage: 'Beige',
    name: 'Meditate',
    icon: 'star',
    streak: 3,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date(Date.now() - 86400000),
    goals: [
      {
        title: 'Low',
        tier: 'low',
        target: 1,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        title: 'Clear',
        tier: 'clear',
        target: 2,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
      {
        title: 'Stretch',
        tier: 'stretch',
        target: 3,
        target_unit: 'u',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ],
    completions: [],
  };

  beforeEach(() => {
    mockWindowDimensions(width, height);
  });

  it('applies the reduced padding density on an unlocked tile', () => {
    const testRenderer = renderer.create(<HabitTile habit={baseHabit} tz="UTC" />);
    const tile = testRenderer.root.findByProps({ testID: 'habit-tile' });
    const style = StyleSheet.flatten(tile.props.style);
    expect(style.paddingVertical).toBe(spacing(tileDensity.paddingV, scale));
    expect(style.paddingHorizontal).toBe(spacing(1, scale));
  });

  it('applies the reduced padding density on a locked tile', () => {
    const testRenderer = renderer.create(<HabitTile habit={baseHabit} locked tz="UTC" />);
    const tile = testRenderer.root.findByProps({ testID: 'habit-tile' });
    const style = StyleSheet.flatten(tile.props.style);
    expect(style.paddingVertical).toBe(spacing(tileDensity.paddingV, scale));
    expect(style.paddingHorizontal).toBe(spacing(1, scale));
  });

  it('pins the habit name font size unchanged by the density pass', () => {
    const { getByText } = render(<HabitTile habit={baseHabit} tz="UTC" />);
    const nameNode = getByText(baseHabit.name);
    const nameStyleFlat = StyleSheet.flatten(nameNode.props.style);
    expect(nameStyleFlat.fontSize).toBe(spacing(2, scale));
  });
});
