/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image, ScrollView, StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';

import { editorialType, ink, surface, touchTarget } from '../../../design/tokens';
import { unlockTimeline } from '../journeyNarrative';
import {
  focusScrollOffset,
  lensFrame,
  LENS_CAPTION_STACK,
  LENS_MAX_HEIGHT,
  LENS_MIN_HEIGHT,
} from '../magnifierGeometry';
import styles, { ANNOTATION_LANE_WIDTH, FIT_CONTENT, WAVE_KEEP_OUT } from '../Map.styles';
import {
  ARROW_LABEL_MAX_FONT_SIZE,
  fitRightLabel,
  fittedTitleFontSize,
  GRID_COLUMN_FLEX,
  MAP_ROWS,
  RIGHT_LABEL_LADDER,
  RIGHT_LABEL_LINE_HEIGHT_RATIO,
  RIGHT_LABEL_MAX_FONT_SIZE,
  RIGHT_LABEL_MIN_FONT_SIZE,
  STAGE_DISPLAY,
  STAGE_LINE_MAX_FONT_SIZE,
  STAGE_PERSONA_MAX_FONT_SIZE,
  STAGE_TEXT_MIN_FONT_SIZE,
} from '../mapLayout';
import MapScreen, { MapBackdrop } from '../MapScreen';
import { STAGE_COUNT } from '../stageData';
import { nominalAnchorY } from '../waveGeometry';
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

  it('navigates to Course with stageNumber when the primary Continue is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'course-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Course', { stageNumber: 1 });
  });

  it('navigates to Practice with stageNumber when the secondary Practice is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'practice-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Practice', { stageNumber: 1 });
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

  it('names the close glyph for a screen reader rather than announcing a bare ×', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const close = tree.root.findByProps({ testID: 'close-modal' });
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('Close stage details');
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
    // The lens caption now reads the tapped stage's subtitle.
    const subtitle = tree.root.findByProps({ testID: 'magnifier-subtitle' });
    expect(subtitle.props.children).toBe('Subtitle 3');
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
    const subtitle = tree.root.findByProps({ testID: 'magnifier-subtitle' });
    expect(subtitle.props.children).toBe('Subtitle 3');
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

  it('announces the padlock a locked grid node already shows', () => {
    // Stages 3-10 are locked (isUnlocked: stageNumber <= 2, derived stage 1),
    // and both grid tap targets render a padlock a screen reader could not see.
    const tree = create(<MapScreen />);

    for (const column of [0, 1]) {
      const hotspot = tree.root.findByProps({ testID: `stage-hotspot-3-${column}` });
      expect(hotspot.props.accessibilityLabel as string).toMatch(/, locked$/);
    }
  });

  it('announces the stage the person is in, and neither marker on an open stage', () => {
    const tree = create(<MapScreen />);

    for (const column of [0, 1]) {
      const current = tree.root.findByProps({ testID: `stage-hotspot-1-${column}` });
      expect(current.props.accessibilityLabel as string).toMatch(/, current$/);
      // Stage 2 is unlocked but is not where the person stands.
      const open = tree.root.findByProps({ testID: `stage-hotspot-2-${column}` });
      expect(open.props.accessibilityLabel as string).not.toContain(', current');
      expect(open.props.accessibilityLabel as string).not.toContain(', locked');
    }
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

  it('pressing begin-again-button calls stageService.beginAgain', async () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    // Deferred handshake: settle the request inside act so the guard's
    // finally-time setState lands while mounted, leaking no post-test microtask.
    let resolveBeginAgain: () => void = () => {};
    mockBeginAgain.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveBeginAgain = resolve;
      }),
    );
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'begin-again-button' }).props.onPress();
    });
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });
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

  it("hyphenates Awareness on the ramp, one line each, in its face's rhythm, in a narrow right cell", () => {
    const NARROW_CELL = 56;
    const tree = create(<MapScreen />);
    fireRightLabelLayout(tree, 'Awareness', NARROW_CELL);
    const expected = fitRightLabel('Awareness', ['Aware-', 'ness'], NARROW_CELL);
    expect(expected.lines).toEqual(['Aware-', 'ness']);
    for (const line of expected.lines) {
      const node = tree.root.findByProps({ children: line });
      expect(node.props.numberOfLines).toBe(1);
      const flat = StyleSheet.flatten(node.props.style) as {
        fontSize?: number;
        lineHeight?: number;
      };
      expect(flat.fontSize).toBe(expected.fontSize);
      expect(RIGHT_LABEL_LADDER).toContain(flat.fontSize);
      expect(flat.lineHeight).toBeCloseTo(
        (flat.fontSize as number) * RIGHT_LABEL_LINE_HEIGHT_RATIO,
      );
    }
    expect(RIGHT_LABEL_LINE_HEIGHT_RATIO).toBe(
      editorialType.marginNote.lineHeight / editorialType.marginNote.fontSize,
    );
  });

  it('lets a label line wrap, never cut to an ellipsis, in a right cell too narrow for it on the ramp', () => {
    // A 320 phone's right cell: Yes-And- runs wider than it at the 13px floor.
    const NARROWEST_PHONE_CELL = 48;
    const tree = create(<MapScreen />);
    fireRightLabelLayout(tree, 'Yes-And-Ness', NARROWEST_PHONE_CELL);
    for (const line of ['Yes-And-', 'Ness']) {
      const node = tree.root.findByProps({ children: line });
      expect(node.props.numberOfLines).toBeUndefined();
      const flat = StyleSheet.flatten(node.props.style) as { fontSize?: number };
      expect(flat.fontSize).toBe(RIGHT_LABEL_MIN_FONT_SIZE);
    }
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

  // Padding on the right cell itself comes off the free space before the flex
  // split and shifts the center column off the fractions the wave is drawn to.
  it('insets the right label inside its cell, leaving the cell unpadded so the columns keep their flex split', () => {
    for (const side of ['padding', 'paddingHorizontal', 'paddingLeft', 'paddingRight']) {
      expect(side in styles.rightCell).toBe(false);
    }
    expect(styles.rightCell.flex).toBe(GRID_COLUMN_FLEX.right);
    expect(styles.rightLabelInset.paddingHorizontal).toBeGreaterThan(0);
    const tree = create(<MapScreen />);
    fireGridLayout(tree);
    for (const row of MAP_ROWS) {
      const band = tree.root.findByProps({ testID: `map-row-${row.rightLabel}` });
      const inset = band.findByProps({ style: styles.rightLabelInset });
      expect(inset.findByProps({ testID: rightLabelFitTestId(row.rightLabel) })).toBeTruthy();
    }
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

  it('wraps the configured background PNG in a non-interactive no-op layer', () => {
    const tree = create(<MapBackdrop uri="file:///bg.png" />);
    const backdrop = tree.root.findByProps({ testID: 'map-background' });
    expect(backdrop.props.pointerEvents).toBe('none');
    // The art renders inside the non-interactive wrapper, not as a bare Image
    // that could intercept touches in the grid's padding regions.
    const image = backdrop.findByType(Image);
    expect(image.props.source).toEqual({ uri: 'file:///bg.png' });
  });

  it('renders the empty backdrop as a non-interactive no-op when no PNG is configured', () => {
    const tree = create(<MapBackdrop uri={null} />);
    const backdrop = tree.root.findByProps({ testID: 'map-background' });
    expect(backdrop.props.pointerEvents).toBe('none');
    expect(backdrop.findAllByType(Image)).toHaveLength(0);
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
        tree.root.findByProps({ testID: `stage-row-${stage}` }).props.onLayout({
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

describe('MapScreen stage-expressions modal integration', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows the stage-expressions section in the modal for a stage with manifestations', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'stage-expressions' })).toBeTruthy();
  });

  it('omits the stage-expressions section in the modal for a stage with no manifestations', () => {
    mockMapState.stages = Array.from({ length: 10 }, (_, i) => {
      const stageNumber = 10 - i;
      return stageNumber === 1
        ? mockMakeStage(1, { manifestations: [] })
        : mockMakeStage(stageNumber);
    });
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'stage-expressions')).toHaveLength(
      0,
    );
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

  // #2657: a padlock stacked on the column centreline sat on the wave, and a
  // fourth stacked line overran the band, so the padlock now rides beside the
  // countdown in one corner row -- on the cell's outer edge, mirrored per corner.
  it('rides the padlock beside the countdown on the outer edge of a locked center cell', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    const textOrder = (testID: string): string[] =>
      tree.root
        .findByProps({ testID })
        .findAll((node: TestNode) => typeof node.props.children === 'string')
        .map((node: TestNode) => node.props.children as string);

    // Stage 8 hugs the right corner: the countdown, then the padlock at the edge.
    const right = textOrder('stage-hotspot-8-1');
    const rightCountdown = right.findIndex((text) => text.startsWith('Unlocks'));
    expect(rightCountdown).toBeGreaterThanOrEqual(0);
    expect(rightCountdown).toBeLessThan(right.indexOf('🔒'));
    // Stage 7 hugs the left corner: the padlock at the edge, then the countdown.
    const left = textOrder('stage-hotspot-7-1');
    expect(left.indexOf('🔒')).toBeGreaterThanOrEqual(0);
    expect(left.indexOf('🔒')).toBeLessThan(left.findIndex((text) => text.startsWith('Unlocks')));
  });

  it('groups stage 1 (Agency) label in the left corner, unlocked with no countdown', () => {
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-1' });
    const flat = StyleSheet.flatten(block.props.style) as { alignItems?: string };
    expect(flat.alignItems).toBe('flex-start');
    expect(block.findAll((node: TestNode) => node.props.testID === 'stage-unlock-1')).toHaveLength(
      0,
    );
  });

  it('groups stage 2 (Receptivity) label in the right corner, unlocked', () => {
    const tree = create(<MapScreen />);
    const block = tree.root.findByProps({ testID: 'aspect-label-2' });
    const flat = StyleSheet.flatten(block.props.style) as { alignItems?: string };
    expect(flat.alignItems).toBe('flex-end');
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

  it('holds the EMPTINESS / UNITY watermark to one line without the native shrink, which leaves the ramp', () => {
    const tree = create(<MapScreen />);
    for (const title of ['EMPTINESS', 'UNITY']) {
      const node = tree.root.findByProps({ children: title });
      expect(node.props.adjustsFontSizeToFit).toBeUndefined();
      expect(node.props.numberOfLines).toBe(1);
    }
  });

  it('sizes both watermark lines at one ramp step from their measured cell width', () => {
    // A phone's center cell: UNITY alone would fit the title face, EMPTINESS
    // only the heading face, and the two lines share the smaller.
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
      expect(flat.fontSize).toBe(fittedTitleFontSize(MEASURED_WIDTH));
      expect(flat.fontSize).toBe(editorialType.heading.fontSize);
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

describe('MapScreen stage-text fit-to-width', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  // Stage 8 carries the longest left-column and arrow-label copy on the Map.
  const STAGE = 8;
  const NARROW_WIDTH = 60;
  const WIDE_WIDTH = 400;

  const stage8 = (() => {
    const display = STAGE_DISPLAY[STAGE];
    if (!display) throw new Error(`no STAGE_DISPLAY entry for stage ${STAGE}`);
    return display;
  })();

  const driveLayout = (tree: ReturnType<typeof create>, testID: string, width: number): void => {
    const wrapper = tree.root.findByProps({ testID });
    act(() => {
      (wrapper.props.onLayout as (e: unknown) => void)({
        nativeEvent: { layout: { width, height: 40 } },
      });
    });
  };

  const leftLineNode = (tree: ReturnType<typeof create>, line: string) => {
    const hotspot = tree.root.findByProps({ testID: `stage-hotspot-${STAGE}-0` });
    return hotspot.findAll((n: TestNode) => n.props.children === line)[0];
  };

  const leftLineFontSize = (tree: ReturnType<typeof create>, line: string): number | undefined => {
    const flat = StyleSheet.flatten(leftLineNode(tree, line).props.style) as { fontSize?: number };
    return flat.fontSize;
  };

  const arrowLabelNode = (tree: ReturnType<typeof create>) => {
    const block = tree.root.findByProps({ testID: `aspect-label-${STAGE}` });
    return block.findAll((n: TestNode) => n.props.children === stage8.arrowLabel)[0];
  };

  it('steps the long stage-8 persona down to the ramp floor and wraps the practice there in a narrow cell', () => {
    const tree = create(<MapScreen />);
    driveLayout(tree, `stage-text-fit-${STAGE}`, NARROW_WIDTH);
    for (const line of [stage8.persona, stage8.practice]) {
      expect(leftLineFontSize(tree, line)).toBe(STAGE_TEXT_MIN_FONT_SIZE);
      // Too long for one line even at the floor: it wraps rather than leaving the ramp.
      expect(leftLineNode(tree, line).props.numberOfLines).toBeUndefined();
    }
    expect(STAGE_TEXT_MIN_FONT_SIZE).toBe(editorialType.caption.fontSize);
  });

  it('keeps every stage-8 left line at the top of its ladder, on one line, in a wide cell', () => {
    const tree = create(<MapScreen />);
    driveLayout(tree, `stage-text-fit-${STAGE}`, WIDE_WIDTH);
    const cases: ReadonlyArray<readonly [string, number]> = [
      [stage8.persona, STAGE_PERSONA_MAX_FONT_SIZE],
      [stage8.descriptor, STAGE_LINE_MAX_FONT_SIZE],
      [stage8.practice, STAGE_LINE_MAX_FONT_SIZE],
    ];
    for (const [line, maxFontSize] of cases) {
      expect(leftLineFontSize(tree, line)).toBe(maxFontSize);
      expect(leftLineNode(tree, line).props.numberOfLines).toBe(1);
    }
  });

  it('renders the stage-8 left lines at exactly their standard sizes before layout reports', () => {
    const tree = create(<MapScreen />);
    expect(leftLineFontSize(tree, stage8.persona)).toBe(STAGE_PERSONA_MAX_FONT_SIZE);
    expect(leftLineFontSize(tree, stage8.descriptor)).toBe(STAGE_LINE_MAX_FONT_SIZE);
    expect(leftLineFontSize(tree, stage8.practice)).toBe(STAGE_LINE_MAX_FONT_SIZE);
  });

  it('holds the True Self arrow label at the caption and lets it wrap in a narrow center cell', () => {
    const tree = create(<MapScreen />);
    driveLayout(tree, `aspect-label-fit-${STAGE}`, NARROW_WIDTH);
    const label = arrowLabelNode(tree);
    const flat = StyleSheet.flatten(label.props.style) as { fontSize?: number };
    expect(flat.fontSize).toBe(ARROW_LABEL_MAX_FONT_SIZE);
    expect(label.props.numberOfLines).toBeUndefined();
  });

  it('keeps the True Self arrow label at its ceiling on one line in a wide center cell', () => {
    const tree = create(<MapScreen />);
    driveLayout(tree, `aspect-label-fit-${STAGE}`, WIDE_WIDTH);
    const label = arrowLabelNode(tree);
    const flat = StyleSheet.flatten(label.props.style) as { fontSize?: number };
    expect(flat.fontSize).toBe(ARROW_LABEL_MAX_FONT_SIZE);
    expect(label.props.numberOfLines).toBe(1);
  });

  it('never hands the fitted stage-8 text to the native shrink, which would leave the ramp', () => {
    const tree = create(<MapScreen />);
    for (const line of [stage8.persona, stage8.descriptor, stage8.practice]) {
      expect(leftLineNode(tree, line).props.adjustsFontSizeToFit).toBeUndefined();
    }
    expect(arrowLabelNode(tree).props.adjustsFontSizeToFit).toBeUndefined();
  });

  it('keeps the stage-8 corner hug and nested countdown intact around the fit wrapper', () => {
    mockMapState.daysUntilStage = 42;
    const tree = create(<MapScreen />);
    driveLayout(tree, `aspect-label-fit-${STAGE}`, NARROW_WIDTH);
    const block = tree.root.findByProps({ testID: `aspect-label-${STAGE}` });
    const flat = StyleSheet.flatten(block.props.style) as { alignItems?: string };
    expect(flat.alignItems).toBe('flex-end');
    expect(block.findByProps({ testID: `stage-unlock-${STAGE}` })).toBeTruthy();
  });
});

describe('MapScreen locked title-row unlock estimate', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  // #2657: centred under the watermark, the estimate sat where the converging
  // wave rises; it now takes its stage's corner lane like every other stage.
  it.each([
    [9, 'left', 'flex-start'],
    [10, 'left', 'flex-start'],
  ])(
    'renders stage %i locked title-row estimate in its %s corner lane, off the centreline',
    (stageNumber, textAlign, alignSelf) => {
      mockMapState.daysUntilStage = 42;
      const tree = create(<MapScreen />);
      const estimate = tree.root.findByProps({ testID: `stage-unlock-${stageNumber}` });
      expect(estimate.props.children).toBe(unlockTimeline(42));
      const flat = StyleSheet.flatten(estimate.props.style) as {
        fontSize?: number;
        color?: string;
        textAlign?: string;
      };
      expect(flat.fontSize).toBe(editorialType.caption.fontSize);
      expect(flat.color).toBe(ink.muted);
      expect(flat.textAlign).toBe(textAlign);
      // The estimate shares its lane with the padlock, whose host parent is the lane.
      const cell = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-1` });
      const lock = cell.findAll(isLockIcon)[0] as TestNode & {
        parent: TestNode & { findAll: typeof cell.findAll };
      };
      const inLane = lock.parent.findAll(
        (n: TestNode) => n.props.testID === `stage-unlock-${stageNumber}`,
      );
      expect(inLane.length).toBeGreaterThan(0);
      const lane = StyleSheet.flatten(lock.parent.props.style) as {
        alignSelf?: string;
        width?: string;
      };
      expect(lane.alignSelf).toBe(alignSelf);
      expect(lane.width).toBe(ANNOTATION_LANE_WIDTH);
    },
  );

  it('omits the unlock estimate on unlocked title rows', () => {
    mockMapState.derivedStage = 10;
    const tree = create(<MapScreen />);
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'stage-unlock-9')).toHaveLength(0);
    expect(tree.root.findAll((n: TestNode) => n.props.testID === 'stage-unlock-10')).toHaveLength(
      0,
    );
  });

  it('keeps the fitted-title sizing intact while the locked estimate renders', () => {
    mockMapState.daysUntilStage = 42;
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
      expect(flat.fontSize).toBe(fittedTitleFontSize(MEASURED_WIDTH));
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

describe('MapScreen stage annotations keep clear of the wave (#2657)', () => {
  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  /** The flattened style of the row that carries a locked stage's padlock in its center cell. */
  const centerLockLane = (tree: ReturnType<typeof create>, stageNumber: number) => {
    const cell = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-1` });
    const lock = cell.findAll(isLockIcon)[0] as TestNode & { parent: TestNode };
    return StyleSheet.flatten(lock.parent.props.style) as {
      flexDirection?: string;
      alignSelf?: string;
      width?: string;
      paddingLeft?: number;
      paddingRight?: number;
    };
  };

  it.each([
    [8, 'flex-end'],
    [7, 'flex-start'],
    [10, 'flex-start'],
    [9, 'flex-start'],
  ])('moves stage %i center padlock off the centreline into its %s lane', (stage, alignSelf) => {
    const tree = create(<MapScreen />);
    const lane = centerLockLane(tree, stage);
    expect(lane.flexDirection).toBe('row');
    expect(lane.alignSelf).toBe(alignSelf);
    expect(lane.width).toBe(ANNOTATION_LANE_WIDTH);
  });

  it('keeps each lane its keep-out clear of the column centre, on the centre side only', () => {
    const tree = create(<MapScreen />);
    const left = centerLockLane(tree, 7);
    const right = centerLockLane(tree, 8);
    expect(left.paddingRight).toBe(WAVE_KEEP_OUT);
    expect(left.paddingLeft).toBeUndefined();
    expect(right.paddingLeft).toBe(WAVE_KEEP_OUT);
    expect(right.paddingRight).toBeUndefined();
    expect(WAVE_KEEP_OUT).toBeGreaterThan(0);
  });

  // react-native-web gives every View min-height 0, which is what let a short
  // grid squeeze a band below its own text and paint one stage onto the next.
  it('never squeezes a band below its content, so a short grid scrolls', () => {
    const tree = create(<MapScreen />);
    for (const row of MAP_ROWS) {
      const band = tree.root.findByProps({ testID: `map-row-${row.rightLabel}` });
      const flat = StyleSheet.flatten(band.props.style) as { minHeight?: string; flex?: number };
      expect(flat.minHeight).toBe(FIT_CONTENT);
      expect(flat.flex).toBe(row.stageNumbers.length);
    }
  });

  // #2960: at the ramp's 13px a stage's copy can wrap and its locked note runs
  // long, so a stage takes the height it needs -- and its two cells take it
  // together, or the left and center rules would stop meeting.
  it('gives each stage one row across the left and center columns, never shorter than its content', () => {
    const tree = create(<MapScreen />);
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const row = tree.root.findByProps({ testID: `stage-row-${stage}` });
      const flat = StyleSheet.flatten(row.props.style) as {
        flexDirection?: string;
        minHeight?: string;
        flex?: number;
      };
      expect(flat).toEqual(
        expect.objectContaining({ flexDirection: 'row', minHeight: FIT_CONTENT, flex: 1 }),
      );
      const hotspots = row
        .findAll((n: TestNode) => /^stage-hotspot-\d+-[01]$/u.test(String(n.props.testID)))
        .map((n: TestNode) => String(n.props.testID));
      expect([...new Set(hotspots)].sort()).toEqual([
        `stage-hotspot-${stage}-0`,
        `stage-hotspot-${stage}-1`,
      ]);
    }
  });

  it("makes the current stage's cell at least as tall as the smallest lens, so the lens's caption stays in its own stage", () => {
    const tree = create(<MapScreen />);
    const minHeightOf = (stage: number): number | string | undefined =>
      (
        StyleSheet.flatten(
          tree.root.findByProps({ testID: `stage-hotspot-${stage}-1` }).props.style,
        ) as { minHeight?: number | string }
      ).minHeight;
    expect(styles.currentStageCell.minHeight).toBe(LENS_MIN_HEIGHT);
    expect(LENS_MIN_HEIGHT).toBeGreaterThan(touchTarget.minimum);
    // A taller lens pushed off centre by the grid's edge moves its caption by
    // less than the glass the caption keeps clear on each side.
    expect((LENS_MAX_HEIGHT - LENS_MIN_HEIGHT) / 2).toBeLessThan(
      (LENS_MIN_HEIGHT - LENS_CAPTION_STACK) / 2,
    );
    // The harness's current stage is stage 1.
    expect(minHeightOf(1)).toBe(LENS_MIN_HEIGHT);
    for (let stage = 2; stage <= STAGE_COUNT; stage += 1) {
      expect(minHeightOf(stage)).toBe(touchTarget.minimum);
    }
  });

  it('gives the top stage no lens room when it is current, so the completed Map keeps Begin again in view', () => {
    // The lens pushed down by the grid's top edge overhangs only stage 9's
    // UNITY watermark; holding stage 10's cell to the lens's height pushed
    // Begin again's button below a 1280x720 window's fold (#2960).
    mockMapState.currentStage = STAGE_COUNT;
    mockMapState.derivedStage = STAGE_COUNT;
    const tree = create(<MapScreen />);
    expect(
      tree.root.findByProps({ testID: `stage-hotspot-${String(STAGE_COUNT)}-1` }).props
        .accessibilityLabel,
    ).toMatch(/current/iu);
    for (let stage = 1; stage <= STAGE_COUNT; stage += 1) {
      const flat = StyleSheet.flatten(
        tree.root.findByProps({ testID: `stage-hotspot-${stage}-1` }).props.style,
      ) as { minHeight?: number | string };
      expect(flat.minHeight).toBe(touchTarget.minimum);
    }
  });

  it("keeps the connector in flow without a top margin, a connector's length off the band edge", () => {
    expect(styles.connector.height).toBeGreaterThan(0);
    expect('position' in styles.connector).toBe(false);
    expect('marginTop' in styles.connector).toBe(false);
  });

  it("stacks a band's stage rows beside its aspect label, spanning the left and center columns", () => {
    const tree = create(<MapScreen />);
    const band = tree.root.findByProps({ testID: 'map-row-Wisdom' });
    const stack = band.findByProps({ style: styles.bandStages });
    expect(styles.bandStages.flex).toBe(GRID_COLUMN_FLEX.left + GRID_COLUMN_FLEX.center);
    for (const stage of [8, 7]) {
      expect(stack.findByProps({ testID: `stage-row-${stage}` })).toBeTruthy();
    }
  });

  it('scrolls the grid and Begin again together, keeping the journey read fixed above', () => {
    mockMapState.isEndOfCycle = jest.fn<boolean, [Record<number, { progress: number }>, number]>(
      () => true,
    );
    const tree = create(<MapScreen />);
    // A real scroller, not a View wearing its testID.
    const [scroll] = tree.root
      .findAllByType(ScrollView)
      .filter((n: TestNode) => n.props.testID === 'map-scroll');
    if (scroll === undefined) throw new Error('map-scroll is not a ScrollView');
    expect(scroll.findByProps({ testID: 'map-grid' })).toBeTruthy();
    expect(scroll.findByProps({ testID: 'begin-again-button' })).toBeTruthy();
    expect(scroll.findAll((n: TestNode) => n.props.testID === 'journey-read')).toHaveLength(0);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toEqual(
      expect.objectContaining({ flexGrow: 1 }),
    );
  });

  it.each([
    [2, 'right'],
    [1, 'left'],
  ])('pins stage %i check badge to the bottom of its %s (label) corner', (stage, corner) => {
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, { progress: 10 - i <= 2 ? 1 : 0 }),
    );
    const tree = create(<MapScreen />);
    const badge = tree.root.findByProps({ testID: `stage-complete-${stage}` });
    const flat = StyleSheet.flatten(badge.props.style) as Record<string, unknown>;
    const other = corner === 'left' ? 'right' : 'left';
    expect(flat.position).toBe('absolute');
    expect(flat[corner]).toBeDefined();
    expect(flat[other]).toBeUndefined();
    expect(flat.bottom).toBeDefined();
    expect(flat.top).toBeUndefined();
  });

  it('still announces the lock on both tap targets and keeps the touch floor', () => {
    const tree = create(<MapScreen />);
    for (const column of [0, 1]) {
      const hotspot = tree.root.findByProps({ testID: `stage-hotspot-8-${column}` });
      expect(String(hotspot.props.accessibilityLabel)).toMatch(/locked/iu);
    }
    expect(styles.centerStageCell.minHeight).toBe(touchTarget.minimum);
  });
});

describe('MapScreen scroller and the magnifier (#2657)', () => {
  const GRID = { width: 300, height: 600 };
  const VIEWPORT_HEIGHT = 200;
  const CONTENT_HEIGHT = 650;

  beforeEach(() => {
    resetMapMocks();
    mockMapState.stages = Array.from({ length: 10 }, (_, i) =>
      mockMakeStage(10 - i, 10 - i === 1 ? { progress: 0.5 } : {}),
    );
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  const mapScroll = (tree: ReturnType<typeof create>) => {
    const [scroll] = tree.root
      .findAllByType(ScrollView)
      .filter((n: TestNode) => n.props.testID === 'map-scroll');
    if (scroll === undefined) throw new Error('map-scroll is not a ScrollView');
    return scroll;
  };

  /** Lay the grid and its scroller out: a 600px grid in a 200px window. */
  const layOut = (tree: ReturnType<typeof create>, contentHeight = CONTENT_HEIGHT) => {
    act(() => {
      tree.root.findByProps({ testID: 'map-grid' }).props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, ...GRID } },
      });
      const scroll = mapScroll(tree);
      scroll.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: GRID.width, height: VIEWPORT_HEIGHT } },
      });
      scroll.props.onContentSizeChange(GRID.width, contentHeight);
    });
  };

  const touch = (pageY: number) => ({ nativeEvent: { pageX: 150, pageY, timestamp: 0 } });

  it('never bounces, so an iOS overscroll cannot cancel a lens drag', () => {
    const tree = create(<MapScreen />);
    expect(mapScroll(tree).props.alwaysBounceVertical).toBe(false);
    expect(mapScroll(tree).props.bounces).toBe(false);
  });

  it('stops the Map scrolling while the lens is held and resumes on release', () => {
    const tree = create(<MapScreen />);
    layOut(tree);
    expect(mapScroll(tree).props.scrollEnabled).toBe(true);

    const lens = tree.root.findByProps({ testID: 'map-magnifier' });
    act(() => lens.props.onResponderGrant(touch(500)));
    expect(mapScroll(tree).props.scrollEnabled).toBe(false);

    act(() => lens.props.onResponderMove(touch(400)));
    expect(mapScroll(tree).props.scrollEnabled).toBe(false);

    act(() => lens.props.onResponderRelease(touch(400)));
    expect(mapScroll(tree).props.scrollEnabled).toBe(true);
  });

  it('scrolls a focused stage below the fold into view when the lens glides to it', () => {
    const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
    const tree = create(<MapScreen />);
    layOut(tree);
    scrollTo.mockClear();

    act(() => tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress());

    const anchorY = nominalAnchorY(3) * GRID.height;
    const expected = focusScrollOffset({
      anchorY,
      halfExtent: lensFrame(GRID.width, GRID.height).height / 2,
      scrollY: 0,
      viewportHeight: VIEWPORT_HEIGHT,
      contentHeight: CONTENT_HEIGHT,
    });
    expect(expected).toBe(anchorY - VIEWPORT_HEIGHT / 2);
    expect(scrollTo).toHaveBeenCalledWith({ y: expected, animated: true });
  });

  it('follows the scroller, so a stage already in the window is not scrolled to', () => {
    const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
    const tree = create(<MapScreen />);
    layOut(tree);
    // The reader has scrolled stage 3 into the window themselves.
    act(() =>
      mapScroll(tree).props.onScroll({
        nativeEvent: { contentOffset: { x: 0, y: nominalAnchorY(3) * GRID.height - 100 } },
      }),
    );
    scrollTo.mockClear();

    act(() => tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress());

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves the scroller alone when the Map fits its window', () => {
    const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
    const tree = create(<MapScreen />);
    layOut(tree, VIEWPORT_HEIGHT);
    scrollTo.mockClear();

    act(() => tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress());

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
