/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

// Mock navigation
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

/** Inline type to avoid import/order conflict with type-only parent imports. */
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

// Mock API — must be declared before use in jest.mock factory
const mockHistoryFn = jest.fn<Promise<StageHistoryData>, [number, string?]>();

jest.mock('../../../api', () => ({
  stages: {
    history: (...args: [number, string?]) => mockHistoryFn(...args),
  },
}));

function mockMakeStage(stageNumber: number, overrides: Partial<{ isUnlocked: boolean }> = {}) {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    progress: 0,
    color: '#aaa',
    isUnlocked: overrides.isUnlocked ?? stageNumber <= 2,
    category: 'Test',
    aspect: 'Aspect',
    spiralDynamicsColor: 'Beige',
    growingUpStage: 'Growing',
    divineGenderPolarity: 'Polarity',
    relationshipToFreeWill: 'Free Will',
    freeWillDescription: 'Description',
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

const HISTORY_WITH_DATA: StageHistoryData = {
  stage_number: 1,
  practices: [
    {
      name: 'Breath of Fire',
      sessions_completed: 12,
      total_minutes: 180,
      last_session: '2026-03-15T10:30:00Z',
    },
  ],
  habits: [
    {
      name: 'Morning Exercise',
      icon: '🏃',
      goals_achieved: { low: true, clear: true, stretch: false },
      best_streak: 14,
      total_completions: 45,
    },
  ],
};

const EMPTY_HISTORY: StageHistoryData = {
  stage_number: 1,
  practices: [],
  habits: [],
};

describe('MapScreen — Stage History', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockHistoryFn.mockReset();
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows history section for unlocked stages', () => {
    const tree = create(<MapScreen />);
    // Open modal for stage 1 (unlocked)
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    const section = tree.root.findByProps({ testID: 'history-section' });
    expect(section).toBeTruthy();
  });

  it('does not show history section for locked stages', () => {
    const tree = create(<MapScreen />);
    // Open modal for stage 3 (locked in our test data)
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-3-0' }).props.onPress();
    });
    const sections = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'history-section',
    );
    expect(sections.length).toBe(0);
  });

  it('shows empty state message for stages with no activity', async () => {
    mockHistoryFn.mockResolvedValueOnce(EMPTY_HISTORY);
    const tree = create(<MapScreen />);

    // Open modal and expand history
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    const empty = tree.root.findByProps({ testID: 'history-empty' });
    expect(empty).toBeTruthy();
    expect(empty.props.children).toContain('Begin this stage');
  });

  it('renders practice and habit history items when expanded', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    const content = tree.root.findByProps({ testID: 'history-content' });
    expect(content).toBeTruthy();

    // Practice items — findAll may return duplicates from deep traversal
    const practiceItems = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'practice-history-item',
    );
    expect(practiceItems.length).toBeGreaterThanOrEqual(1);

    // Habit items
    const habitItems = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => node.props.testID === 'habit-history-item',
    );
    expect(habitItems.length).toBeGreaterThanOrEqual(1);
  });

  it('renders goal tier badges for habits', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });

    // Should have 3 goal badges (low, clear, stretch)
    const badges = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('goal-badge-'),
    );
    // Deep traversal may find duplicates; at minimum 3 unique tiers
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it('lazy loads history data only when expanded', async () => {
    mockHistoryFn.mockResolvedValueOnce(HISTORY_WITH_DATA);
    const tree = create(<MapScreen />);

    // Open modal — history API should NOT be called yet
    await act(async () => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(mockHistoryFn).not.toHaveBeenCalled();

    // Expand history — NOW it should fetch
    await act(async () => {
      tree.root.findByProps({ testID: 'history-toggle' }).props.onPress();
    });
    expect(mockHistoryFn).toHaveBeenCalledWith(1);
  });
});
