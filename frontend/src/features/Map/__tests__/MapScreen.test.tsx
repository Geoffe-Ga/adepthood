/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';
import { BALANCE_COPY, emphasisStyle, FULLNESS_ALIVE_THRESHOLD } from '../wheelBalance';

// Mock InteractionManager to run callbacks synchronously in tests.
jest.mock('react-native/Libraries/Interaction/InteractionManager', () => ({
  runAfterInteractions: (cb: () => void) => {
    cb();
    return { then: () => {}, done: () => {}, cancel: () => {} };
  },
}));

// Mock navigation so we can observe tab linking behaviour.
const mockNavigate = jest.fn();
jest.mock('../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Default wheel state: all stages thin (zero fullness). Override per-test.
let mockWheelFullnessByStage: Record<number, number> = {};
let mockWheelLoading = false;
let mockWheelError: string | null = null;
jest.mock('../hooks/useWheelBalance', () => ({
  useWheelBalance: () => ({
    fullnessByStage: mockWheelFullnessByStage,
    loading: mockWheelLoading,
    error: mockWheelError,
  }),
}));

// Control the date-derived current stage without importing the real program
// store (which trips this suite's brittle Image-effect teardown). MapScreen
// consumes ``useDerivedCurrentStage`` directly, so mocking it here drives both
// the "current" highlight and the calendar-based unlock.
let mockDerivedStage = 1;
let mockDerivedWeek = 1;
let mockDaysUntilStage: number | null = null;
jest.mock('../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (fallback: number) => mockDerivedStage ?? fallback,
  useDerivedCurrentWeek: (fallback: number) => mockDerivedWeek ?? fallback,
  useDaysUntilStage: () => mockDaysUntilStage,
}));

/** Build a realistic StageData for testing (must be prefixed with mock). */
function mockMakeStage(stageNumber: number) {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    progress: stageNumber === 1 ? 0.5 : 0,
    color: '#aaa',
    isUnlocked: stageNumber <= 2,
    category: 'Test',
    aspect: 'Aspect',
    spiralDynamicsColor: 'Beige',
    growingUpStage: 'Growing',
    divineGenderPolarity: 'Polarity',
    relationshipToFreeWill: 'Free Will',
    freeWillDescription: 'Description of free will.',
    overviewUrl: '',
    hotspots: [
      { top: (10 - stageNumber) * 8 + 4, left: 4, width: 32, height: 6 },
      { top: (10 - stageNumber) * 8 + 4, left: 34, width: 40, height: 6 },
    ],
  };
}

const mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));

const mockLoadStages = jest.fn();
jest.mock('../services/stageService', () => ({
  stageService: { loadStages: (...args: unknown[]) => mockLoadStages(...args) },
  isStageUnlocked: (
    stage: { isUnlocked: boolean; stageNumber: number },
    currentStage: number | null,
  ) => stage.isUnlocked || (currentStage !== null && stage.stageNumber <= currentStage),
}));

const buildMockStageState = () => ({
  stages: mockStages,
  stagesByNumber: Object.fromEntries(mockStages.map((s) => [s.stageNumber, s])),
  stageOrder: mockStages.map((s) => s.stageNumber),
  currentStage: 1,
  loading: false,
  error: null,
  setStages: jest.fn(),
  setCurrentStage: jest.fn(),
  setLoading: jest.fn(),
  setError: jest.fn(),
  updateStageProgress: jest.fn(),
});

jest.mock('../../../store/useStageStore', () => ({
  useStageStore: jest.fn((selector) => {
    const mockState = buildMockStageState();
    return selector ? selector(mockState) : mockState;
  }),
  selectStages: (s: { stages: unknown }) => s.stages,
  selectCurrentStage: (s: { currentStage: unknown }) => s.currentStage,
  selectStagesLoading: (s: { loading: unknown }) => s.loading,
  selectStagesError: (s: { error: unknown }) => s.error,
  selectStageByNumber:
    (n: number | null | undefined) => (s: { stagesByNumber: Record<number, unknown> }) =>
      n == null ? undefined : s.stagesByNumber[n],
}));

// react-test-renderer ships no types here, so structurally type just the prop
// we read instead of reaching for `any`.
const isLockIcon = (node: { props: { children?: unknown } }): boolean =>
  node.props.children === '🔒';

const countLockIcons = (tree: ReturnType<typeof create>): number =>
  tree.root.findAll(isLockIcon).length;

/** Whether the first hotspot of ``stageNumber`` renders a padlock overlay. */
const hotspotHasLock = (tree: ReturnType<typeof create>, stageNumber: number): boolean => {
  const hotspot = tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` });
  return hotspot.findAll(isLockIcon).length > 0;
};

describe('MapScreen', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockDerivedStage = 1;
    mockDerivedWeek = 1;
    mockDaysUntilStage = null;
    mockWheelFullnessByStage = {};
    mockWheelLoading = false;
    mockWheelError = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders text and arrow hotspots for each stage', () => {
    const tree = create(<MapScreen />);
    const hotspots = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    const unique = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hotspots.map((s: any) => s.props.testID as string),
    );
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
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
    mockDerivedStage = 5;
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
    mockWheelFullnessByStage = { 3: FULLNESS_ALIVE_THRESHOLD, 1: 0.0 };
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
    mockWheelFullnessByStage = { 3: FULLNESS_ALIVE_THRESHOLD };
    const tree = create(<MapScreen />);
    const hotspot = tree.root.findByProps({ testID: 'stage-hotspot-3-0' });
    expect(hotspot.props.accessibilityLabel as string).toContain('reads full');
  });

  it('thin node accessibilityLabel contains "reads thin" suffix', () => {
    mockWheelFullnessByStage = { 1: 0.0 };
    const tree = create(<MapScreen />);
    const hotspot = tree.root.findByProps({ testID: 'stage-hotspot-1-0' });
    expect(hotspot.props.accessibilityLabel as string).toContain('reads thin');
  });

  it('BalanceSummary renders all-thin copy when every stage is 0.0', () => {
    mockWheelFullnessByStage = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i + 1, 0.0]),
    );
    const tree = create(<MapScreen />);
    const summary = tree.root.findByProps({ testID: 'balance-summary' });
    expect(summary.props.children as string).toBe(BALANCE_COPY.allThin);
  });

  it('BalanceSummary renders mixed copy when some stages are alive', () => {
    mockWheelFullnessByStage = { 3: FULLNESS_ALIVE_THRESHOLD, 7: 0.9 };
    const tree = create(<MapScreen />);
    const summary = tree.root.findByProps({ testID: 'balance-summary' });
    expect(summary.props.children as string).toBe(BALANCE_COPY.mixed);
  });

  it('BalanceSummary renders all-alive copy when every stage is at full fullness', () => {
    mockWheelFullnessByStage = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i + 1, 1.0]),
    );
    const tree = create(<MapScreen />);
    const summary = tree.root.findByProps({ testID: 'balance-summary' });
    expect(summary.props.children as string).toBe(BALANCE_COPY.allAlive);
  });

  it('BALANCE_COPY constants contain none of the banned gamification words', () => {
    const BANNED = /\b(level|climb|ascend|higher|rank|altitude|ladder)\b/i;
    for (const [key, value] of Object.entries(BALANCE_COPY)) {
      expect(BANNED.test(value)).toBe(false);
      // Confirms key name for the pinned-contract assertion.
      expect(['allThin', 'mixed', 'allAlive']).toContain(key);
    }
  });

  it('Map spiral grid remains visible while wheel data is loading', () => {
    mockWheelLoading = true;
    const tree = create(<MapScreen />);

    // The grid must be present — wheel loading never blanks the spiral.
    const hotspots = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    expect(hotspots.length).toBeGreaterThan(0);
    // No full-screen loader should obscure the grid.
    expect(() => tree.root.findByProps({ testID: 'map-loading' })).toThrow();
  });
});
