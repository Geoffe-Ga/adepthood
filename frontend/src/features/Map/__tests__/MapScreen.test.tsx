/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image, StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ink, surface } from '../../../design/tokens';
import styles from '../Map.styles';
import {
  fitRightLabel,
  fittedTitleFontSize,
  MAP_ROWS,
  RIGHT_LABEL_LINE_HEIGHT_RATIO,
  RIGHT_LABEL_MAX_FONT_SIZE,
  RIGHT_LABEL_MIN_FONT_SIZE,
  STAGE_DISPLAY,
} from '../mapLayout';
import MapScreen from '../MapScreen';
import { STAGE_COUNT } from '../stageData';
import { FULLNESS_ALIVE_THRESHOLD } from '../wheelBalance';

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
// Reduced-motion-safe path: the magnifier lens repositions instantly instead
// of gliding, and the hook's async AccessibilityInfo read never resolves
// outside act(). The glide/frost animation paths are covered in
// MagnifierLens.test.tsx under fake timers.
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));
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

  it('shows modal with stage details when a hotspot is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const modal = tree.root.findByProps({ testID: 'stage-modal' });
    expect(modal).toBeTruthy();
  });

  it('displays rich metadata in the stage modal', () => {
    // Sentinel values distinctive from any other text in the tree.
    mockMapState.stages = Array.from({ length: 10 }, (_, i) => {
      const stageNumber = 10 - i;
      return stageNumber === 1
        ? mockMakeStage(1, {
            progress: 0.5,
            category: 'Zorbonic Category',
            aspect: 'Zorbonic Aspect',
            growingUpStage: 'Zorbonic Growing Stage',
            divineGenderPolarity: 'Zorbonic Polarity',
            relationshipToFreeWill: 'Zorbonic Free Will Relationship',
            freeWillDescription: 'Zorbonic free will description text.',
          })
        : mockMakeStage(stageNumber);
    });
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const metadata = tree.root.findByProps({ testID: 'stage-metadata' });
    // Dedupe: findAll returns both the composite and host instance per Text node.
    const rendered = new Set(
      metadata
        .findAll((n: TestNode) => typeof n.props.children === 'string')
        .map((n: TestNode) => n.props.children as string),
    );
    for (const value of [
      'Zorbonic Category',
      'Zorbonic Aspect',
      'Zorbonic Growing Stage',
      'Zorbonic Polarity',
      'Zorbonic Free Will Relationship',
      'Zorbonic free will description text.',
    ]) {
      expect(rendered.has(value)).toBe(true);
    }
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

  it('navigates to the Journal tab when Journal is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'journal-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Journal');
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

  // --- magnifier lens interaction -----------------------------------------

  it('first tap on a non-focused stage glides the lens there without opening the modal', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress();
    });
    // No modal yet — the tap moved the lens instead.
    expect(() => tree.root.findByProps({ testID: 'stage-modal' })).toThrow();
    // The lens caption now reads the tapped stage's Aspect word.
    const headline = tree.root.findByProps({ testID: 'magnifier-headline' });
    expect(headline.props.children).toBe('Self-Love');
    // And the chip hides, since the lens left the current stage.
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'you-are-here')).toHaveLength(0);
  });

  it('second tap on the now-focused stage opens its modal', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-1' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'stage-modal' })).toBeTruthy();
  });

  it('tapping the lens itself opens the focused stage modal', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    const touch = { nativeEvent: { pageX: 150, pageY: 570 } };
    act(() => {
      lens.props.onResponderGrant(touch);
      lens.props.onResponderRelease(touch);
    });
    expect(tree.root.findByProps({ testID: 'stage-modal' })).toBeTruthy();
  });

  it('a lens drag released over another stage settles focus there', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    // Stage 1 rests near y=570 (0.95 * 600); stage 3's band center is y=450.
    act(() => {
      lens.props.onResponderGrant({ nativeEvent: { pageX: 150, pageY: 570 } });
      lens.props.onResponderMove({ nativeEvent: { pageX: 150, pageY: 450 } });
      lens.props.onResponderRelease({ nativeEvent: { pageX: 150, pageY: 450 } });
    });
    const headline = tree.root.findByProps({ testID: 'magnifier-headline' });
    expect(headline.props.children).toBe('Self-Love');
    // The settled stage now opens on a single stage tap (it is focused).
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'stage-modal' })).toBeTruthy();
  });

  it('renders connection lines between adjacent stages', () => {
    const tree = create(<MapScreen />);
    const connections = tree.root.findAll(
      (node: TestNode) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-connection'),
    );
    // 10 stages, 9 gaps between them (dedupe composite + host by testID).
    const unique = new Set(connections.map((c: TestNode) => c.props.testID as string));
    expect(unique.size).toBe(9);
  });

  it('shows exactly 16 lock icons across the 8 locked stages (2 per stage)', () => {
    const tree = create(<MapScreen />);
    // Stages 3-10 are locked (isUnlocked: stageNumber <= 2), derived stage is 1.
    // Count hotspots carrying a padlock (boolean per hotspot dodges the
    // composite + host double-count): 8 locked stages across 2 columns = 16.
    let lockedHotspots = 0;
    for (let stageNumber = 1; stageNumber <= 10; stageNumber += 1) {
      for (const column of [0, 1]) {
        const hotspot = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-${column}` });
        if (hotspot.findAll(isLockIcon).length > 0) {
          lockedHotspots += 1;
        }
      }
    }
    expect(lockedHotspots).toBe(16);
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

  it('renders unlocked stages at full opacity even when the wheel reads thin', () => {
    // Stage 1 is unlocked but reads thin — the balance must stay an a11y-only
    // read, never a washed-out (greyed) stage block.
    mockMapState.wheelFullnessByStage = { 1: 0.0 };
    const tree = create(<MapScreen />);

    const unlockedHotspot = tree.root.findByProps({ testID: 'stage-hotspot-1-0' });
    const flat = StyleSheet.flatten(unlockedHotspot.props.style as unknown[]) as {
      opacity?: number;
    };
    expect(flat.opacity ?? 1).toBe(1);
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

  it('renders wave arrowheads at stages 1, 5, and 9 after layout', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
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

  // Right-column labels now fit their own measured cell width, mirroring the
  // EMPTINESS/UNITY FittedTitle idiom: a measured wrapper (`right-label-fit-*`)
  // drives a `fitRightLabel` computation, rather than a static pre-hyphenated
  // two-line Text.
  const rightLabelFitTestId = (label: string): string => `right-label-fit-${label}`;

  const fireRightLabelLayout = (
    tree: ReturnType<typeof create>,
    label: string,
    width: number,
  ): void => {
    act(() => {
      (
        tree.root.findByProps({ testID: rightLabelFitTestId(label) }).props.onLayout as (
          _e: unknown,
        ) => void
      )({ nativeEvent: { layout: { width, height: 20 } } });
    });
  };

  it('renders a fitted right-label wrapper for all six Aspect rows after the wave overlay renders', () => {
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    for (const row of MAP_ROWS) {
      expect(tree.root.findByProps({ testID: rightLabelFitTestId(row.rightLabel) })).toBeTruthy();
    }
  });

  it('renders Understanding as one un-hyphenated line in a wide right cell', () => {
    const WIDE_CELL = 180;
    const tree = create(<MapScreen />);
    fireRightLabelLayout(tree, 'Understanding', WIDE_CELL);
    const node = tree.root.findByProps({ children: 'Understanding' });
    expect(node.props.numberOfLines).toBe(1);
    const flat = StyleSheet.flatten(node.props.style) as { fontSize?: number };
    expect(flat.fontSize).toBe(RIGHT_LABEL_MAX_FONT_SIZE);
  });

  it('shrinks Awareness to a single fitted line with a reduced, ratio-consistent fontSize in a narrow right cell', () => {
    const NARROW_CELL = 56;
    const tree = create(<MapScreen />);
    fireRightLabelLayout(tree, 'Awareness', NARROW_CELL);
    const node = tree.root.findByProps({ children: 'Awareness' });
    expect(node.props.numberOfLines).toBe(1);
    const flat = StyleSheet.flatten(node.props.style) as {
      fontSize?: number;
      lineHeight?: number;
    };
    const expected = fitRightLabel('Awareness', ['Awareness'], NARROW_CELL);
    expect(flat.fontSize).toBe(expected.fontSize);
    expect(flat.fontSize).toBeLessThan(RIGHT_LABEL_MAX_FONT_SIZE);
    expect(flat.fontSize).toBeGreaterThanOrEqual(RIGHT_LABEL_MIN_FONT_SIZE);
    expect(flat.lineHeight).toBeCloseTo((flat.fontSize as number) * RIGHT_LABEL_LINE_HEIGHT_RATIO);
  });

  it('always carries android_hyphenationFrequency="none" and textBreakStrategy="simple", unconditionally', () => {
    // Before any right-label wrapper has reported a measured width, every row
    // renders its full label as one line (fitRightLabel's width<=0 case) — a
    // single stable target per row, independent of hyphenation strategy.
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    for (const row of MAP_ROWS) {
      const node = tree.root.findByProps({ children: row.rightLabel });
      expect(node.props.android_hyphenationFrequency).toBe('none');
      expect(node.props.textBreakStrategy).toBe('simple');
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

  it('drops the hardcoded fontSize/lineHeight from the base rightLabelText style (both are now computed per-fit)', () => {
    expect('fontSize' in styles.rightLabelText).toBe(false);
    expect('lineHeight' in styles.rightLabelText).toBe(false);
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

  const fireOverlayGridLayout = (tree: ReturnType<typeof create>) => {
    act(() => {
      tree.root.findByProps({ testID: 'map-grid' }).props.onLayout({
        nativeEvent: { layout: { width: 300, height: 600 } },
      });
    });
  };

  it('you-are-here chip rides the magnifier lens, not the center cell', () => {
    const tree = create(<MapScreen />);
    // Before the grid reports a size there is no lens (and no chip).
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'you-are-here')).toHaveLength(0);
    fireOverlayGridLayout(tree);
    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    expect(lens.findByProps({ testID: 'you-are-here' })).toBeTruthy();
    // The chip no longer stacks inside the current stage's center cell.
    const cell = tree.root.findByProps({ testID: 'stage-hotspot-1-1' });
    expect(cell.findAll((n: TestNode) => n.props.testID === 'you-are-here')).toHaveLength(0);
  });

  it('the magnifier lens floats absolutely over the grid as a glass pill', () => {
    const tree = create(<MapScreen />);
    fireOverlayGridLayout(tree);
    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    const flat = StyleSheet.flatten(lens.props.style) as {
      position?: string;
      borderRadius?: number;
      height?: number;
    };
    expect(flat.position).toBe('absolute');
    // Full pill: radius is half the lens height.
    expect(flat.borderRadius).toBe((flat.height ?? 0) / 2);
    // The glass magnifies the wave: a second, prefixed copy of the overlay.
    expect(lens.findByProps({ testID: 'magnifier-map-wave' })).toBeTruthy();
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

  it('unlock countdown hugs its corner instead of spanning and centering', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const countdown = tree.root.findByProps({ testID: 'stage-unlock-8' });
    const flat = StyleSheet.flatten(countdown.props.style) as {
      alignSelf?: string;
      textAlign?: string;
    };
    expect(flat.textAlign).toBe('right');
    expect(flat.textAlign).not.toBe('center');
    expect(flat.alignSelf).not.toBe('stretch');
  });

  it('locked stages keep the recessed opacity treatment', () => {
    const tree = create(<MapScreen />);
    const centerHotspot = tree.root.findByProps({ testID: 'stage-hotspot-8-1' });
    const flat = StyleSheet.flatten(centerHotspot.props.style) as { opacity?: number };
    expect(flat.opacity).toBe(0.4);
  });

  it('puts the left-column lock on the far left, not on a fourth stacked line', () => {
    const tree = create(<MapScreen />);
    const leftHotspot = tree.root.findByProps({ testID: 'stage-hotspot-8-0' });

    // The block lays out as a row with its content vertically centered, so
    // the padlock sits beside the three text lines, never below them.
    const flat = StyleSheet.flatten(leftHotspot.props.style) as {
      flexDirection?: string;
      alignItems?: string;
    };
    expect(flat.flexDirection).toBe('row');
    expect(flat.alignItems).toBe('center');

    // The lock renders before the persona text (far left of the row).
    const texts = leftHotspot
      .findAll((node: TestNode) => typeof node.props.children === 'string')
      .map((node: TestNode) => node.props.children as string);
    const display = STAGE_DISPLAY[8];
    expect(texts.indexOf('🔒')).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf('🔒')).toBeLessThan(texts.indexOf(display!.persona));
  });

  it('centers the three text lines of an unlocked left block across its height', () => {
    const tree = create(<MapScreen />);
    const leftHotspot = tree.root.findByProps({ testID: 'stage-hotspot-1-0' });
    // No lock for an unlocked stage, and the text column centers vertically.
    expect(leftHotspot.findAll(isLockIcon)).toHaveLength(0);
    expect(styles.stageLines.justifyContent).toBe('center');
    expect(styles.stageLines.flex).toBe(1);
  });

  // The YOU ARE HERE pill now rides the magnifier lens, so the center cell of
  // a locked stage only needs to keep the countdown above its padlock.
  it('stacks the countdown above the lock in a locked center cell', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const textOrder = (testID: string): string[] =>
      tree.root
        .findByProps({ testID })
        .findAll((node: TestNode) => typeof node.props.children === 'string')
        .map((node: TestNode) => node.props.children as string);

    // Locked stage 8: the countdown copy renders before the lock glyph.
    const lockedText = textOrder('stage-hotspot-8-1');
    const countdownIndex = lockedText.findIndex((text) => text.startsWith('Unlocks'));
    expect(countdownIndex).toBeGreaterThanOrEqual(0);
    expect(countdownIndex).toBeLessThan(lockedText.indexOf('🔒'));
  });

  it('groups stage 1 (Agency) label in the left corner, unlocked with no countdown', () => {
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-1' });
    const flat = StyleSheet.flatten(block.props.style) as { alignSelf?: string };
    expect(flat.alignSelf).toBe('flex-start');
    expect(block.findAll((node: TestNode) => node.props.testID === 'stage-unlock-1')).toHaveLength(
      0,
    );
  });

  it('groups stage 2 (Receptivity) label in the right corner, unlocked', () => {
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-2' });
    const flat = StyleSheet.flatten(block.props.style) as { alignSelf?: string };
    expect(flat.alignSelf).toBe('flex-end');
  });

  it('nests the locked stage 8 (True Self) countdown inside its right-corner block', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-8' });
    const countdown = block.findByProps({ testID: 'stage-unlock-8' });
    expect(countdown).toBeTruthy();
    const flat = StyleSheet.flatten(countdown.props.style) as { textAlign?: string };
    expect(flat.textAlign).toBe('right');
  });

  it('nests the locked stage 3 (Self-Love) countdown inside its left-corner block', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-3' });
    const label = block.findAll((node: TestNode) => node.props.children === 'Self-Love');
    expect(label.length).toBeGreaterThan(0);
    const countdown = block.findByProps({ testID: 'stage-unlock-3' });
    const flat = StyleSheet.flatten(countdown.props.style) as { textAlign?: string };
    expect(flat.textAlign).toBe('left');
  });
});

describe('MapScreen left-column stage text color', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  // Sample rows spanning the top, a paired middle row, and the two bottom rows.
  const SAMPLE_STAGES = [10, 8, 3, 1];

  const requireDisplay = (stageNumber: number) => {
    const display = STAGE_DISPLAY[stageNumber];
    if (!display) {
      throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
    }
    return display;
  };

  it('renders persona, descriptor, and practice in the leftTextColor, not the wave textColor', () => {
    const tree = create(<MapScreen />);
    for (const stageNumber of SAMPLE_STAGES) {
      const display = requireDisplay(stageNumber);
      const hotspot = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` });
      for (const line of [display.persona, display.descriptor, display.practice]) {
        const textNode = hotspot.findAll((n: TestNode) => n.props.children === line)[0];
        const flat = StyleSheet.flatten(textNode.props.style) as { color?: string };
        expect(flat.color).toBe(display.leftTextColor);
        expect(flat.color).not.toBe(display.textColor);
      }
    }
  });

  it('shrinks the EMPTINESS / UNITY title watermark to fit on one line', () => {
    const tree = create(<MapScreen />);
    for (const title of ['EMPTINESS', 'UNITY']) {
      const node = tree.root.findByProps({ children: title });
      expect(node.props.adjustsFontSizeToFit).toBe(true);
      expect(node.props.numberOfLines).toBe(1);
    }
  });

  it('sizes the title watermark from its measured cell width (react-native-web fit)', () => {
    // adjustsFontSizeToFit is a no-op on react-native-web, so the title must
    // carry a deterministic fitted fontSize computed from the measured width.
    const MEASURED_WIDTH = 140;
    const tree = create(<MapScreen />);
    for (const title of ['EMPTINESS', 'UNITY']) {
      const wrapper = tree.root.findByProps({ testID: `title-fit-${title}` });
      act(() => {
        (wrapper.props.onLayout as (e: unknown) => void)({
          nativeEvent: { layout: { width: MEASURED_WIDTH, height: 40 } },
        });
      });
      const node = tree.root.findByProps({ children: title });
      const flat = StyleSheet.flatten(node.props.style) as { fontSize?: number };
      expect(flat.fontSize).toBe(fittedTitleFontSize(title, MEASURED_WIDTH));
    }
  });

  it('renders the EMPTINESS / UNITY title watermark in the muted ink, not the primary ink', () => {
    const tree = create(<MapScreen />);
    for (const title of ['EMPTINESS', 'UNITY']) {
      const node = tree.root.findByProps({ children: title });
      const flat = StyleSheet.flatten(node.props.style) as { color?: string };
      expect(flat.color).toBe(ink.muted);
    }
  });
});

// The Map is a table, and a table reads as one through its rules: gentle
// horizontal lines between the aspect bands (and the stacked stages within
// them) and vertical lines between the three columns. They are rendered as the
// thinnest possible hairline in the faint warm rule colour so they whisper the
// grid rather than caging it.
describe('MapScreen soft grid lines', () => {
  type BorderStyle = {
    borderTopWidth?: number;
    borderTopColor?: string;
    borderRightWidth?: number;
    borderRightColor?: string;
  };

  const topBorder = (tree: ReturnType<typeof create>, testID: string): BorderStyle =>
    StyleSheet.flatten(tree.root.findByProps({ testID }).props.style) as BorderStyle;

  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('draws soft vertical dividers between the three columns in the faint rule colour', () => {
    expect(styles.leftCell.borderRightWidth).toBeGreaterThan(0);
    expect(styles.leftCell.borderRightColor).toBe(surface.hairline);
    expect(styles.centerCell.borderRightWidth).toBeGreaterThan(0);
    expect(styles.centerCell.borderRightColor).toBe(surface.hairline);
  });

  it('renders the column dividers as the thinnest hairline so they read gently', () => {
    expect(styles.leftCell.borderRightWidth).toBe(StyleSheet.hairlineWidth);
    expect(styles.centerCell.borderRightWidth).toBe(StyleSheet.hairlineWidth);
  });

  it('draws a soft full-width horizontal rule above every aspect row except the first', () => {
    const tree = create(<MapScreen />);
    const awareness = topBorder(tree, 'map-row-Awareness');
    const being = topBorder(tree, 'map-row-Being');
    expect(awareness.borderTopWidth ?? 0).toBe(0);
    expect(being.borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(being.borderTopColor).toBe(surface.hairline);
  });

  it('divides stacked stages within a paired row with a soft line across left + center', () => {
    const tree = create(<MapScreen />);
    // The Yes-And-Ness row pairs stage 2 (top) over stage 1 (bottom). The top
    // stage sits on the row boundary (drawn by the row itself), so only the
    // bottom stage carries the within-row rule — across both its columns.
    for (const column of [0, 1]) {
      expect(topBorder(tree, `stage-hotspot-2-${column}`).borderTopWidth ?? 0).toBe(0);
      const bottom = topBorder(tree, `stage-hotspot-1-${column}`);
      expect(bottom.borderTopWidth).toBe(StyleSheet.hairlineWidth);
      expect(bottom.borderTopColor).toBe(surface.hairline);
    }
  });

  it('never draws a rule above the topmost stage (no double line under the header)', () => {
    const tree = create(<MapScreen />);
    for (const column of [0, 1]) {
      expect(topBorder(tree, `stage-hotspot-10-${column}`).borderTopWidth ?? 0).toBe(0);
    }
  });
});

describe('MapScreen content-width cap', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders the map grid inside the shared content-capped container', () => {
    const tree = create(<MapScreen />);
    const container = tree.root.findByProps({ testID: 'content-container' });
    expect(container.findByProps({ testID: 'map-grid' })).toBeTruthy();
  });

  it('gives the shared content-capped container a bounded fill so native scroll/touch chains hold', () => {
    const tree = create(<MapScreen />);
    const container = tree.root.findByProps({ testID: 'content-container' });
    const flat = StyleSheet.flatten(container.props.style) as { flex?: number };
    expect(flat.flex).toBe(1);
  });
});
