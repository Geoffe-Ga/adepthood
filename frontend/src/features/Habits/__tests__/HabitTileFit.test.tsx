import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

import { spacing, touchTarget, tileDensity, type } from '../../../design/tokens';
import type { Habit } from '../Habits.types';
import { useTileLayout, HabitTile, STACKED_STREAK_MAX_TILE_WIDTH } from '../HabitTile';

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
  const { tileMinHeight, gridGutter, scale, streakStacked } = useTileLayout();
  return (
    <>
      <Text testID="probe-streak-stacked">{String(streakStacked)}</Text>
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

  const nameFontSize = (): number | undefined => {
    const { getByText } = render(<HabitTile habit={baseHabit} tz="UTC" />);
    return StyleSheet.flatten(getByText(baseHabit.name).props.style).fontSize;
  };

  // #2961: the name is set on the type ramp's label face, not the layout scale.
  it('pins the habit name font size to the type ramp label face', () => {
    expect(nameFontSize()).toBe(type(width).label.fontSize);
  });

  // The ramp follows width alone: a short viewport no longer takes the layout
  // scale's 0.85 height factor, so the name keeps its phone size. Whether the
  // text then fits is a layout question Jest cannot answer (nothing is laid out
  // here); the 320x568 and 360x640 passes in
  // `e2e/habits-viewport.browser.e2e.test.ts` are the fit proof.
  it('keeps the phone name size on a short viewport', () => {
    const shortHeight = 640;
    mockWindowDimensions(width, shortHeight);
    expect(nameFontSize()).toBe(type(width).label.fontSize);
  });
});

/**
 * #2961: on a tile too narrow to carry the name and the achieved-today badge on
 * one row, the streak moves under the name. The browser spec measures the
 * result; these pin the rule and the structure it produces, which is what keeps
 * native (where Text does not shrink) from breaking the name mid-word.
 */
describe('HabitTile streak placement on narrow tiles', () => {
  const achievedHabit: Habit = {
    id: 7,
    stage: 'Beige',
    name: 'Journalling',
    icon: '✍',
    streak: 12,
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
    ],
    completions: [{ id: 'c-1', timestamp: new Date(), completed_units: 1 }],
  };

  const readStacked = (): string => {
    const { getByTestId } = render(
      <SafeAreaInsetsContext.Provider value={PHONE_INSETS}>
        <TileLayoutProbe />
      </SafeAreaInsetsContext.Provider>,
    );
    return String(getByTestId('probe-streak-stacked').props.children);
  };

  it.each([
    [320, 568, 'true'],
    [360, 640, 'true'],
    [STACKED_STREAK_MAX_TILE_WIDTH - 1, 844, 'true'],
    [STACKED_STREAK_MAX_TILE_WIDTH, 844, 'false'],
    [390, 844, 'false'],
    [1280, 720, 'false'],
  ])('at %ix%i stacks the streak under the name: %s', (w, h, expected) => {
    mockWindowDimensions(w, h);
    expect(readStacked()).toBe(expected);
  });

  it('puts the achieved badge on its own line under the name on a 320px tile', () => {
    mockWindowDimensions(320, 568);
    const { getByTestId, getByText } = render(<HabitTile habit={achievedHabit} tz="UTC" />);
    const stack = getByTestId('habit-name-stack');
    const streak = getByTestId('habit-streak');
    expect(streak).toHaveTextContent(/ACHIEVED TODAY/);
    expect(stack).toContainElement(getByText(achievedHabit.name));
    expect(stack).toContainElement(streak);
    expect(StyleSheet.flatten(stack.props.style).flexDirection).toBeUndefined();
    // The pill hugs its text rather than stretching across the column.
    expect(StyleSheet.flatten(streak.props.style).alignSelf).toBe('flex-start');
  });

  it('keeps the name and badge on one row on a 390px tile', () => {
    mockWindowDimensions(390, 844);
    const { queryByTestId, getByTestId, getByText } = render(
      <HabitTile habit={achievedHabit} tz="UTC" />,
    );
    expect(queryByTestId('habit-name-stack')).toBeNull();
    expect(StyleSheet.flatten(getByText(achievedHabit.name).props.style).flex).toBe(1);
    expect(StyleSheet.flatten(getByTestId('habit-streak').props.style).alignSelf).toBeUndefined();
  });
});
