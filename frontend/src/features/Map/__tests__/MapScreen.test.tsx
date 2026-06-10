/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

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

// Control the date-derived current stage without importing the real program
// store (which trips this suite's brittle Image-effect teardown). MapScreen
// consumes ``useDerivedCurrentStage`` directly, so mocking it here drives both
// the "current" highlight and the calendar-based unlock.
let mockDerivedStage = 1;
jest.mock('../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (fallback: number) => mockDerivedStage ?? fallback,
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

import MapScreen from '../MapScreen';

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
});
