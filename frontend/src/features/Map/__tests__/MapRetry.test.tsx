/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// audit-ux-03: a failed map refresh (with cached stages) must surface a retry
// banner instead of silently showing stale data, and a failed history fetch must
// render an error+retry distinct from the genuinely-empty state.
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
jest.mock('../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (fallback: number) => fallback,
  useDerivedCurrentWeek: (fallback: number) => fallback,
  useDaysUntilStage: () => null,
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
  stages: { history: (...args: [number, string?]) => mockHistoryFn(...args) },
}));

function mockMakeStage(stageNumber: number) {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    progress: 0,
    color: '#aaa',
    isUnlocked: stageNumber <= 2,
    category: 'Test',
    aspect: 'Aspect',
    spiralDynamicsColor: 'Beige',
    growingUpStage: 'Growing',
    divineGenderPolarity: 'Polarity',
    relationshipToFreeWill: 'Free Will',
    freeWillDescription: 'Description',
    overviewUrl: '',
    hotspots: [{ top: (10 - stageNumber) * 8 + 4, left: 4, width: 32, height: 6 }],
  };
}

const mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
const mockLoadStages = jest.fn();
// Mutable so each test drives the store's error field (prefixed ``mock`` so the
// jest.mock factory may reference it).
let mockError: string | null = null;

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
  error: mockError,
  setStages: jest.fn(),
  setCurrentStage: jest.fn(),
  setLoading: jest.fn(),
  setError: jest.fn(),
  updateStageProgress: jest.fn(),
});

jest.mock('../../../store/useStageStore', () => ({
  useStageStore: jest.fn((selector) => {
    const state = buildMockStageState();
    return selector ? selector(state) : state;
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

const EMPTY_HISTORY: StageHistoryData = { stage_number: 1, practices: [], habits: [] };

const countByTestId = (tree: ReturnType<typeof create>, testID: string): number =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree.root.findAll((node: any) => node.props.testID === testID).length;

describe('MapScreen — refresh retry', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockHistoryFn.mockReset();
    mockError = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows a retry banner when a refresh fails while stages are cached', () => {
    mockError = 'Network error';
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-refresh-error' })).toBeTruthy();
    const retry = tree.root.findByProps({ testID: 'map-refresh-retry' });

    act(() => retry.props.onPress());
    expect(mockLoadStages).toHaveBeenCalledTimes(1);
  });

  it('does not show the refresh banner when there is no error', () => {
    const tree = create(<MapScreen />);
    expect(countByTestId(tree, 'map-refresh-error')).toBe(0);
  });
});

describe('MapScreen — stage history error vs empty', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockHistoryFn.mockReset();
    mockError = null;
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('renders an error+retry (not the empty copy) when the history fetch fails', async () => {
    mockHistoryFn.mockRejectedValueOnce(new Error('boom'));
    const tree = create(<MapScreen />);
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'history-error' })).toBeTruthy();
    expect(countByTestId(tree, 'history-empty')).toBe(0);

    // Retry re-runs the fetch; this time it resolves empty → empty copy shows.
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    await act(async () => {
      tree.root.findByProps({ testID: 'history-retry' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ testID: 'history-empty' })).toBeTruthy();
    expect(countByTestId(tree, 'history-error')).toBe(0);
  });

  it('still shows the empty copy for a genuinely empty history', async () => {
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    const tree = create(<MapScreen />);
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'history-empty' })).toBeTruthy();
    expect(countByTestId(tree, 'history-error')).toBe(0);
  });
});
