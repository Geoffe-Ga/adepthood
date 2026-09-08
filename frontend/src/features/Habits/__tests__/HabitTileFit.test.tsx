import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

import { spacing, touchTarget, tileDensity } from '../../../design/tokens';
import type { Habit } from '../Habits.types';
import { useTileLayout, HabitTile } from '../HabitTile';

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

/**
 * What `useTileLayout` promises, and what it does not.
 *
 * This suite used to close with a `totalHeight <= 844` "fit invariant" built
 * from a local `computeChrome` that was a verbatim copy of the hook's own
 * expression, applied to the `tileMinHeight` that same expression had just
 * produced. It was true by construction and could not have failed, and the
 * thing it appeared to guard is in fact false: a real browser measures a full
 * page of ten habits overflowing the grid's box by 147px at 1280x720 and 129px
 * at 390x844 (`e2e/habits-viewport.browser.e2e.test.ts`). Jest cannot settle
 * that question at all -- this project runs the `node` environment, so nothing
 * here is ever laid out -- so the tautology is gone rather than restated, and
 * what remains are the properties the hook really does hold: the density pins
 * at each named profile, the touch-target floor, and the direction the reserve
 * moves as the viewport shortens.
 */
const SHORTENING_HEIGHTS = [844, 700, 600, 500];
const PHONE_INSETS: Insets = { top: 47, bottom: 34, left: 0, right: 0 };

describe('useTileLayout density budget', () => {
  it('pins the row height it reserves on the phone profile', () => {
    mockWindowDimensions(390, 844);
    const { tileMinHeight } = renderTileLayout(PHONE_INSETS);

    expect(tileMinHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    // Concrete expected density at the target profile: a chrome-model drift or
    // a token change breaks this without any test restating the model.
    const EXPECTED_TILE_MIN_HEIGHT = 62;
    expect(tileMinHeight).toBe(EXPECTED_TILE_MIN_HEIGHT);
  });

  it('gives back height as the viewport shortens, never below the touch floor', () => {
    const reserved = SHORTENING_HEIGHTS.map((height) => {
      mockWindowDimensions(390, height);
      return renderTileLayout(PHONE_INSETS).tileMinHeight;
    });

    for (const height of reserved) {
      expect(height).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
    expect(reserved).toEqual([...reserved].sort((a, b) => b - a));
    expect(Math.max(...reserved)).toBeGreaterThan(Math.min(...reserved));
  });

  it('clamps tileMinHeight to the touch-target floor on a short viewport', () => {
    mockWindowDimensions(390, 500);
    const insets: Insets = { top: 20, bottom: 0, left: 0, right: 0 };
    const { tileMinHeight } = renderTileLayout(insets);

    expect(tileMinHeight).toBe(touchTarget.minimum);
  });

  it('reclaims the retired tab-bar band on a small screen', () => {
    mockWindowDimensions(360, 640);
    const insets: Insets = { top: 24, bottom: 0, left: 0, right: 0 };
    const { tileMinHeight } = renderTileLayout(insets);

    // Computed density for this small profile — coincidentally equal to the
    // removed tab-bar constant, not a reintroduction of it.
    const EXPECTED_SMALL_SCREEN_TILE_MIN_HEIGHT = 49;
    expect(tileMinHeight).toBe(EXPECTED_SMALL_SCREEN_TILE_MIN_HEIGHT);
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
