/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image, StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

import styles from '../Map.styles';
import { MAP_ROWS } from '../mapLayout';
import MapScreen from '../MapScreen';
import { STAGE_COUNT } from '../stageData';
import { emphasisStyle, FULLNESS_ALIVE_THRESHOLD } from '../wheelBalance';

import {
  mockBeginAgain,
  mockMakeStage,
  mockMapState,
  mockNavigate,
  resetMapMocks,
} from './mapTestHarness';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () =>
  jest.requireActual('./mapTestHarness').mockInteractionManagerModule(),
);
jest.mock('../../../navigation/hooks', () =>
  jest.requireActual('./mapTestHarness').mockNavigationModule(),
);
jest.mock('@react-navigation/bottom-tabs', () =>
  jest.requireActual('./mapTestHarness').mockBottomTabsModule(),
);
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('./mapTestHarness').mockSafeAreaModule(),
);
jest.mock('../hooks/useWheelBalance', () =>
  jest.requireActual('./mapTestHarness').mockWheelBalanceModule(),
);
jest.mock('../../../store/useProgramProgression', () =>
  jest.requireActual('./mapTestHarness').mockProgramProgressionModule(),
);
jest.mock('../services/stageService', () =>
  jest.requireActual('./mapTestHarness').mockStageServiceModule(),
);
jest.mock('../../../store/useStageStore', () =>
  jest.requireActual('./mapTestHarness').mockStageStoreModule(),
);

// react-test-renderer ships no node types, so structurally type just the props.
type TestNode = { props: Record<string, unknown> };

const isLockIcon = (node: TestNode): boolean => node.props.children === '🔒';

const countLockIcons = (tree: ReturnType<typeof create>): number =>
  tree.root.findAll(isLockIcon).length;

/** Whether the first hotspot of ``stageNumber`` renders a padlock overlay. */
const hotspotHasLock = (tree: ReturnType<typeof create>, stageNumber: number): boolean => {
  const hotspot = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` });
  return hotspot.findAll(isLockIcon).length > 0;
};

describe('MapScreen', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders text and arrow hotspots for each stage', () => {
    const tree = create(<MapScreen />);
    const hotspots = tree.root.findAll(
      (node: TestNode) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    const unique = new Set(hotspots.map((s: TestNode) => s.props.testID as string));
    // Each stage has 2 hotspots = 20 total
    expect(unique.size).toBe(20);
  });

  it('shows modal with stage details when a hotspot is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const modal = tree.root.findByProps({ testID: 'stage-modal' });
    expect(modal).toBeTruthy();
  });

  it('displays rich metadata in the stage modal', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const metadata = tree.root.findByProps({ testID: 'stage-metadata' });
    expect(metadata).toBeTruthy();
  });

  it('navigates to Practice with stageNumber when Practice is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'practice-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Practice', { stageNumber: 1 });
  });

  it('navigates to Course with stageNumber when Course is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'course-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Course', { stageNumber: 1 });
  });

  it('navigates to Journal with stage_reflection tag when Journal is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'journal-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Journal', {
      tag: 'stage_reflection',
      stageNumber: 1,
    });
  });

  it('closes modal when X is pressed', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'close-modal' }).props.onPress();
    });
    expect(() => tree.root.findByProps({ testID: 'stage-modal' })).toThrow();
  });

  it('closes modal when tapping outside content', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'modal-overlay' }).props.onPress();
    });
    expect(() => tree.root.findByProps({ testID: 'stage-modal' })).toThrow();
  });

  it('renders connection lines between adjacent stages', () => {
    const tree = create(<MapScreen />);
    const connections = tree.root.findAll(
      (node: TestNode) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-connection'),
    );
    // 10 stages → 9 gaps, but connections only render when next stage exists
    expect(connections.length).toBeGreaterThanOrEqual(9);
  });

  it('shows lock icon on locked stages', () => {
    const tree = create(<MapScreen />);
    // Stages 3–10 are locked in test data (isUnlocked: stageNumber <= 2) and
    // the derived current stage is 1, so the server flags stand.
    // 8 locked stages × 2 hotspots each; findAll may traverse into React internals
    expect(countLockIcons(tree)).toBeGreaterThanOrEqual(16);
  });

  it('unlocks stages up to the date-derived current stage even when the server still locks them', () => {
    // Calendar has reached stage 5. Stages 3–5 are server-locked
    // (isUnlocked: stageNumber <= 2) but the calendar overrides, so only
    // stages 6–10 stay padlocked: 5 stages × 2 hotspots = 10.
    mockMapState.derivedStage = 5;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });
    // Stage 4 is server-locked but the calendar (stage 5) has reached it → no
    // padlock. Stage 8 is beyond the calendar → still padlocked.
    expect(hotspotHasLock(tree, 4)).toBe(false);
    expect(hotspotHasLock(tree, 5)).toBe(false);
    expect(hotspotHasLock(tree, 8)).toBe(true);
    act(() => tree.unmount());
  });

  // --- Wheel-of-wholeness balance tests ---

  it('alive node (fullness >= threshold) renders with higher opacity than a thin node', () => {
    // Stage 3 is alive; stage 1 is thin.
    mockMapState.wheelFullnessByStage = { 3: FULLNESS_ALIVE_THRESHOLD, 1: 0.0 };
    const tree = create(<MapScreen />);

    const aliveHotspot = tree.root.findByProps({ testID: 'stage-hotspot-3-0' });
    const thinHotspot = tree.root.findByProps({ testID: 'stage-hotspot-1-0' });

    const aliveOpacity = emphasisStyle(FULLNESS_ALIVE_THRESHOLD).opacity;
    const thinOpacity = emphasisStyle(0.0).opacity;

    // The alive node must render with a visually distinct (higher) opacity.
    expect(aliveOpacity).toBeGreaterThan(thinOpacity as number);

    // The alive hotspot carries the alive-emphasis style; the thin does not.
    const aliveStyles = (aliveHotspot.props.style as unknown[]).flat(10);
    const thinStyles = (thinHotspot.props.style as unknown[]).flat(10);
    const opacityOf = (styles: unknown[]) =>
      styles.reduce<number | undefined>((acc, s) => {
        if (s && typeof s === 'object' && 'opacity' in (s as object)) {
          return (s as { opacity: number }).opacity;
        }
        return acc;
      }, undefined);

    expect(opacityOf(aliveStyles)).toBeGreaterThan(opacityOf(thinStyles) ?? 0);
  });

  it('alive node accessibilityLabel contains "reads full" suffix', () => {
    mockMapState.wheelFullnessByStage = { 3: FULLNESS_ALIVE_THRESHOLD };
    const tree = create(<MapScreen />);
    const hotspot = tree.root.findByProps({ testID: 'stage-hotspot-3-0' });
    expect(hotspot.props.accessibilityLabel as string).toContain('reads full');
  });

  it('thin node accessibilityLabel contains "reads thin" suffix', () => {
    mockMapState.wheelFullnessByStage = { 1: 0.0 };
    const tree = create(<MapScreen />);
    const hotspot = tree.root.findByProps({ testID: 'stage-hotspot-1-0' });
    expect(hotspot.props.accessibilityLabel as string).toContain('reads thin');
  });

  it('Map spiral grid remains visible while wheel data is loading', () => {
    mockMapState.wheelLoading = true;
    const tree = create(<MapScreen />);

    // The grid must be present — wheel loading never blanks the spiral.
    const hotspots = tree.root.findAll(
      (node: TestNode) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    expect(hotspots.length).toBeGreaterThan(0);
    // No full-screen loader should obscure the grid.
    expect(() => tree.root.findByProps({ testID: 'map-loading' })).toThrow();
  });

  it('does not render the wavelength explainer trigger', () => {
    const tree = create(<MapScreen />);
    expect(() => tree.root.findByProps({ testID: 'wavelength-explainer-trigger' })).toThrow();
  });

  it('does not render the balance summary', () => {
    const tree = create(<MapScreen />);
    expect(() => tree.root.findByProps({ testID: 'balance-summary' })).toThrow();
  });

  // --- begin-again affordance ---

  it('shows begin-again-button at end of cycle', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    const tree = create(<MapScreen />);
    const btn = tree.root.findByProps({ testID: 'begin-again-button' });
    expect(btn).toBeTruthy();
  });

  it('pressing begin-again-button calls stageService.beginAgain', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    mockBeginAgain.mockResolvedValue(undefined);
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'begin-again-button' }).props.onPress();
    });
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);
  });

  it('double-pressing begin-again-button sends exactly one request', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    // Never-resolving so the in-flight guard stays true across both presses;
    // the second tap must be a no-op or a second POST would skip a cycle.
    mockBeginAgain.mockReturnValue(new Promise<void>(() => {}));
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'begin-again-button' }).props.onPress();
      tree.root.findByProps({ testID: 'begin-again-button' }).props.onPress();
    });
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);
  });

  it('disables begin-again-button while a begin-again request is in flight', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    mockBeginAgain.mockReturnValue(new Promise<void>(() => {}));
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'begin-again-button' }).props.onPress();
    });
    const btn = tree.root.findByProps({ testID: 'begin-again-button' });
    // The Button node carries the in-flight guard via its ``disabled`` prop.
    expect(btn.props.disabled).toBe(true);
  });

  it('begin-again-button is absent mid-cycle', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => false,
    );
    const tree = create(<MapScreen />);
    expect(
      tree.root.findAll((n: TestNode) => n.props.testID === 'begin-again-button'),
    ).toHaveLength(0);
  });

  // --- cycle-indicator ---

  it('shows cycle-indicator with "Cycle 2" when cycleNumber is 2', () => {
    mockMapState.cycleNumber = 2;
    const tree = create(<MapScreen />);
    const indicator = tree.root.findByProps({ testID: 'cycle-indicator' });
    expect(indicator).toBeTruthy();
    const flat = (indicator.props.children as unknown[]).flat
      ? (indicator.props.children as unknown[]).flat(10)
      : [indicator.props.children];
    const text = flat.join('');
    expect(text).toContain('Cycle 2');
  });

  it('cycle-indicator is absent when cycleNumber is 1', () => {
    mockMapState.cycleNumber = 1;
    const tree = create(<MapScreen />);
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'cycle-indicator')).toHaveLength(
      0,
    );
  });

  // --- sine-wave overlay (struck-tuning-fork) ---

  const WAVE_LAYOUT_WIDTH = 300;
  const WAVE_LAYOUT_HEIGHT = 600;
  const MIN_WAVE_SEGMENTS = 9;

  const fireGridLayout = (tree: ReturnType<typeof create>) => {
    act(() => {
      tree.root.findByProps({ testID: 'map-grid' }).props.onLayout({
        nativeEvent: { layout: { width: WAVE_LAYOUT_WIDTH, height: WAVE_LAYOUT_HEIGHT } },
      });
    });
  };

  it('renders the wave overlay once the grid reports a non-zero layout size', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    expect(tree.root.findByProps({ testID: 'map-wave' })).toBeTruthy();
  });

  it('renders at least 9 wave path segments and arrowheads after layout', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const paths = tree.root.findAll(
      (node: TestNode) => typeof node.props.d === 'string' && node.props.d.length > 0,
    );
    expect(paths.length).toBeGreaterThanOrEqual(MIN_WAVE_SEGMENTS);
    expect(tree.root.findByProps({ testID: 'wave-arrow-1' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'wave-arrow-5' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'wave-arrow-9' })).toBeTruthy();
  });

  it('does not render the wave overlay before the grid has reported a size', () => {
    const tree = create(<MapScreen />);
    expect(() => tree.root.findByProps({ testID: 'map-wave' })).toThrow();
  });

  it('no longer renders the old directional arrow glyphs', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const glyphNodes = tree.root.findAll(
      (node: TestNode) => node.props.children === '↩' || node.props.children === '↪',
    );
    expect(glyphNodes).toHaveLength(0);
  });

  it('keeps every stage-hotspot present after the wave overlay renders', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const hotspots = tree.root.findAll(
      (node: TestNode) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    const unique = new Set(hotspots.map((s: TestNode) => s.props.testID as string));
    expect(unique.size).toBe(20);
  });

  it('keeps you-are-here present for the current stage after the wave overlay renders', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    expect(tree.root.findByProps({ testID: 'you-are-here' })).toBeTruthy();
  });

  // Right-column labels render as row.rightLabelLines joined by a newline in
  // a single Text node (static hyphenation, not shrink-to-fit).
  const findRightLabelNode = (
    tree: ReturnType<typeof create>,
    row: (typeof MAP_ROWS)[number],
  ): TestNode => {
    const expectedChildren = row.rightLabelLines.join('\n');
    const matches = tree.root.findAll((n: TestNode) => n.props.children === expectedChildren);
    const node = matches[0];
    if (!node) {
      throw new Error(`no right-label Text found for ${row.rightLabel}`);
    }
    return node;
  };

  it('keeps all six Aspect labels present after the wave overlay renders', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    for (const row of MAP_ROWS) {
      expect(findRightLabelNode(tree, row)).toBeTruthy();
    }
  });

  it('renders each right-column Aspect label as a static two-line Text, no auto-fit', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    for (const row of MAP_ROWS) {
      const node = findRightLabelNode(tree, row);
      expect(node.props.numberOfLines).toBe(2);
      expect(node.props.adjustsFontSizeToFit).toBeUndefined();
      expect(node.props.minimumFontScale).toBeUndefined();
    }
  });

  it('still keys each right-column row by its rightLabel testID after hyphenation', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    expect(tree.root.findByProps({ testID: 'map-row-Understanding' })).toBeTruthy();
  });

  // --- right-cell edge padding ---

  it('gives the right cell symmetric horizontal padding (no left-only padding)', () => {
    expect(styles.rightCell.paddingHorizontal).toBeTruthy();
    expect('paddingLeft' in styles.rightCell).toBe(false);
  });

  it('renders the wave overlay independent of MAP_BACKGROUND_URI (MapBackdrop is a no-op)', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    // MapBackdrop still renders its placeholder testID regardless of the PNG,
    // and the wave overlay renders alongside it with no dependency between them.
    expect(tree.root.findByProps({ testID: 'map-background' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'map-wave' })).toBeTruthy();
  });

  // --- wave overlay follows measured row/cell centers, not nominal bands ---

  const MAP_ROW_LABELS = [
    'Awareness',
    'Being',
    'Wisdom',
    'Understanding',
    'Love',
    'Yes-And-Ness',
  ] as const;
  type MapRowLabel = (typeof MAP_ROW_LABELS)[number];
  const ROW_Y_BY_LABEL: Record<MapRowLabel, number> = {
    Awareness: 0,
    Being: 40,
    Wisdom: 90,
    Understanding: 260,
    Love: 380,
    'Yes-And-Ness': 500,
  };
  const TARGET_ROW_LABEL: MapRowLabel = 'Yes-And-Ness';
  const CELL_LAYOUT_Y = 0;
  const CELL_LAYOUT_HEIGHT = 40;
  const CELL_LAYOUT_WIDTH = 100;
  const NOMINAL_BAND_MIDPOINT = 0.5;
  const MEASURED_TARGET_STAGE = 1;

  const nominalPixelY = (stageNumber: number, height: number): number =>
    ((STAGE_COUNT - stageNumber + NOMINAL_BAND_MIDPOINT) / STAGE_COUNT) * height;

  const parseArrowMidY = (points: string): number => {
    const ys = points
      .trim()
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]));
    return (Math.min(...ys) + Math.max(...ys)) / 2;
  };

  it('reflects measured non-uniform row/cell centers in wave-arrow y-coordinates, not the nominal equal bands', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);

    act(() => {
      for (const label of MAP_ROW_LABELS) {
        tree.root.findByProps({ testID: `map-row-${label}` }).props.onLayout({
          nativeEvent: {
            layout: {
              x: 0,
              y: ROW_Y_BY_LABEL[label],
              width: WAVE_LAYOUT_WIDTH,
              height: CELL_LAYOUT_HEIGHT,
            },
          },
        });
      }
      for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
        tree.root.findByProps({ testID: `stage-hotspot-${stage}-1` }).props.onLayout({
          nativeEvent: {
            layout: {
              x: 0,
              y: CELL_LAYOUT_Y,
              width: CELL_LAYOUT_WIDTH,
              height: CELL_LAYOUT_HEIGHT,
            },
          },
        });
      }
    });

    const arrow = tree.root.findByProps({ testID: `wave-arrow-${MEASURED_TARGET_STAGE}` });
    const midY = parseArrowMidY(arrow.props.points as string);
    const measuredCenterY = ROW_Y_BY_LABEL[TARGET_ROW_LABEL] + CELL_LAYOUT_HEIGHT / 2;

    expect(midY).toBeCloseTo(measuredCenterY);
    expect(midY).not.toBeCloseTo(nominalPixelY(MEASURED_TARGET_STAGE, WAVE_LAYOUT_HEIGHT));
  });
});

describe('MapScreen center-cell overlay layout', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('you-are-here pill is laid out in flow (not absolutely positioned)', () => {
    const tree = create(<MapScreen />);
    const pill = tree.root.findByProps({ testID: 'you-are-here' });
    const flat = StyleSheet.flatten(pill.props.style) as { position?: string };
    expect(flat.position).not.toBe('absolute');
  });

  it('locked center cell renders the unlock countdown in flow (not absolutely positioned)', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const countdown = tree.root.findByProps({ testID: 'stage-unlock-8' });
    const flat = StyleSheet.flatten(countdown.props.style) as {
      position?: string;
      bottom?: number;
    };
    expect(flat.position).not.toBe('absolute');
    expect(flat.bottom).toBeUndefined();
  });

  it('locked cell lock glyph is not an absolute-fill overlay in either column', () => {
    const tree = create(<MapScreen />);
    const leftHotspot = tree.root.findByProps({ testID: 'stage-hotspot-8-0' });
    const centerHotspot = tree.root.findByProps({ testID: 'stage-hotspot-8-1' });
    for (const hotspot of [leftHotspot, centerHotspot]) {
      const lockIcon = hotspot.findAll(isLockIcon)[0];
      const lockWrapper = lockIcon.parent as TestNode;
      const flat = StyleSheet.flatten(lockWrapper.props.style) as { position?: string };
      expect(flat.position).not.toBe('absolute');
    }
  });

  it('unlock countdown spans the full cell width so its centered copy stays centered', () => {
    // Restores the full-width box the old ``left: 0, right: 0`` absolute
    // positioning gave: without ``alignSelf: 'stretch'`` an in-flow Text
    // shrink-wraps to its widest wrapped line and ``textAlign: 'center'``
    // becomes a no-op for the multi-line unlock-condition copy.
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const countdown = tree.root.findByProps({ testID: 'stage-unlock-8' });
    const flat = StyleSheet.flatten(countdown.props.style) as {
      alignSelf?: string;
      textAlign?: string;
    };
    expect(flat.alignSelf).toBe('stretch');
    expect(flat.textAlign).toBe('center');
  });

  it('locked stages keep the recessed opacity treatment', () => {
    const tree = create(<MapScreen />);
    const centerHotspot = tree.root.findByProps({ testID: 'stage-hotspot-8-1' });
    const flat = StyleSheet.flatten(centerHotspot.props.style) as { opacity?: number };
    expect(flat.opacity).toBe(0.4);
  });

  it('stacks the pill above the label and the countdown below the lock', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const textOrder = (testID: string): string[] =>
      tree.root
        .findByProps({ testID })
        .findAll((node: TestNode) => typeof node.props.children === 'string')
        .map((node: TestNode) => node.props.children as string);

    // Current stage 1: the pill renders before its centered label ('Agency').
    const currentText = textOrder('stage-hotspot-1-1');
    expect(currentText.indexOf('YOU ARE HERE')).toBeLessThan(currentText.indexOf('Agency'));
    expect(currentText.indexOf('YOU ARE HERE')).toBeGreaterThanOrEqual(0);

    // Locked stage 8: the lock renders before the countdown copy.
    const lockedText = textOrder('stage-hotspot-8-1');
    const countdownIndex = lockedText.findIndex((text) => text.startsWith('Unlocks'));
    expect(lockedText.indexOf('🔒')).toBeGreaterThanOrEqual(0);
    expect(lockedText.indexOf('🔒')).toBeLessThan(countdownIndex);
  });
});
