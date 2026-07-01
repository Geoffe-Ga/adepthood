/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () => ({
  runAfterInteractions: (cb: () => void) => {
    cb();
    return { then: () => {}, done: () => {}, cancel: () => {} };
  },
}));

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

// Reduced-motion-safe path: no Animated pulse (Animated trips the test
// renderer's InteractionManager). Asserts the celebration still renders at rest.
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

let mockDerivedStage = 1;
let mockDerivedWeek = 1;
let mockDaysUntilStage: number | null = null;
jest.mock('../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (fallback: number) => mockDerivedStage ?? fallback,
  useDerivedCurrentWeek: (fallback: number) => mockDerivedWeek ?? fallback,
  useDaysUntilStage: () => mockDaysUntilStage,
}));

interface StageHistoryData {
  stage_number: number;
  practices: Array<{
    name: string;
    sessions_completed: number;
    total_minutes: number;
    last_session: string | null;
  }>;
  habits: Array<{
    name: string;
    icon: string;
    goals_achieved: Record<string, boolean>;
    best_streak: number;
    total_completions: number;
  }>;
}

const mockHistoryFn = jest.fn<Promise<StageHistoryData>, [number, string?]>();
jest.mock('../../../api', () => ({
  stages: {
    history: (...args: [number, string?]) => mockHistoryFn(...args),
  },
}));

function mockMakeStage(stageNumber: number, progress = 0) {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    progress,
    color: '#abcdef',
    isUnlocked: stageNumber <= 2,
    category: 'Test',
    aspect: 'Aspect',
    spiralDynamicsColor: 'Beige',
    growingUpStage: 'Growing',
    divineGenderPolarity: 'Polarity',
    relationshipToFreeWill: 'Free Will',
    freeWillDescription: 'Description of free will.',
    overviewUrl: '',
  };
}

let mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));

const mockLoadStages = jest.fn();
jest.mock('../services/stageService', () => ({
  stageService: { loadStages: (...args: unknown[]) => mockLoadStages(...args) },
  isEndOfCycle: () => false,
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
}));

import MapScreen from '../MapScreen';

import { showcase } from '@/design/tokens';

const findText = (tree: ReturnType<typeof create>, fragment: string): boolean =>
  tree.root.findAll(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) =>
      typeof node.props.children === 'string' && node.props.children.includes(fragment),
  ).length > 0;

const openStage = (tree: ReturnType<typeof create>, stageNumber: number): void => {
  act(() => {
    tree.root.findByProps({ testID: `stage-hotspot-${stageNumber}-0` }).props.onPress();
  });
};

describe('MapScreen — journey narrative', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockHistoryFn.mockReset();
    mockDerivedStage = 5;
    mockDerivedWeek = 12;
    mockDaysUntilStage = null;
    mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders the compact journey read "Stage N of 10 · Week W"', () => {
    const tree = create(<MapScreen />);
    const read = tree.root.findByProps({ testID: 'journey-read' });
    expect(read).toBeTruthy();
    expect(findText(tree, 'Stage 5 of 10 · Week 12')).toBe(true);
  });

  it('marks the current stage with a "you are here" marker + halo', () => {
    const tree = create(<MapScreen />);
    const markers = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'you-are-here',
    );
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(findText(tree, 'YOU ARE HERE')).toBe(true);
  });

  it('shows an "Unlocks in N days" timeline on a locked stage', () => {
    // Calendar at stage 5, so stage 8 is locked.
    mockDaysUntilStage = 9;
    const tree = create(<MapScreen />);
    const unlock = tree.root.findByProps({ testID: 'stage-unlock-8' });
    expect(unlock).toBeTruthy();
    expect(findText(tree, 'Unlocks in 9 days')).toBe(true);
  });

  it('grounds the detail modal on the showcase surface tinted with the stage colour', () => {
    const tree = create(<MapScreen />);
    openStage(tree, 1);
    const modal = tree.root.findByProps({ testID: 'stage-modal' });
    const flat = Array.isArray(modal.props.style)
      ? Object.assign({}, ...modal.props.style.filter(Boolean))
      : modal.props.style;
    expect(flat.backgroundColor).toBe(showcase.canvas);
    expect(flat.borderLeftColor).toBe('#abcdef');
  });

  it('renders a one-sentence history + ranked stats + retained medals', async () => {
    mockHistoryFn.mockResolvedValueOnce({
      stage_number: 1,
      practices: [
        { name: 'Breath', sessions_completed: 12, total_minutes: 180, last_session: null },
      ],
      habits: [
        {
          name: 'Exercise',
          icon: '🏃',
          goals_achieved: { low: true, clear: true, stretch: false },
          best_streak: 14,
          total_completions: 45,
        },
      ],
    });
    const tree = create(<MapScreen />);
    openStage(tree, 1);
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'progression-sentence' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'ranked-stats' })).toBeTruthy();
    // One progression sentence.
    expect(findText(tree, 'You logged 12 sessions')).toBe(true);
    // Medals retained.
    const badges = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('goal-badge-'),
    );
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it('ranks the modal actions into a primary Continue + two secondary, all wired', () => {
    const tree = create(<MapScreen />);
    openStage(tree, 1);

    // Primary action keeps the practice-link handler but reads "Continue".
    expect(findText(tree, 'Continue')).toBe(true);
    act(() => tree.root.findByProps({ testID: 'practice-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Practice', { stageNumber: 1 });

    // Each action closes the modal on navigate, so reopen between presses; the
    // two secondary actions remain wired to Course / Journal.
    openStage(tree, 1);
    act(() => tree.root.findByProps({ testID: 'course-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Course', { stageNumber: 1 });

    openStage(tree, 1);
    act(() => tree.root.findByProps({ testID: 'journal-link' }).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Journal', {
      tag: 'stage_reflection',
      stageNumber: 1,
    });
  });

  it('plays the Celebration when a stage newly completes', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<MapScreen />);
    });
    // No celebration on first paint (baseline seeded).
    const celebrations = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (n: any) => n.props.testID === 'stage-celebration',
    );
    expect(celebrations.length).toBe(0);

    // Stage 3 completes → re-render with the new progress.
    mockStages = mockStages.map((s) => (s.stageNumber === 3 ? { ...s, progress: 1 } : s));
    act(() => {
      tree.update(<MapScreen />);
    });

    const celebration = tree.root.findByProps({ testID: 'stage-celebration' });
    expect(celebration).toBeTruthy();
    // Names the next stage that unlocked.
    expect(findText(tree, 'Stage 4 unlocked')).toBe(true);
    act(() => tree.unmount());
  });
});
