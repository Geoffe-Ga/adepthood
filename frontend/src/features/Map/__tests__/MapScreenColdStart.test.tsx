/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Other MapScreen suites always seed 10 cached stages, so the store-driven MapLoading/MapError early returns never render; this file covers those plus a stage with no free-will description.
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

jest.mock('../../../api', () => ({
  stages: { history: () => new Promise(() => {}) },
}));

function mockMakeStage(stageNumber: number, overrides: Record<string, unknown> = {}) {
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
    freeWillDescription: 'Description of free will.',
    overviewUrl: '',
    ...overrides,
  };
}

let mockStages: ReturnType<typeof mockMakeStage>[] = Array.from({ length: 10 }, (_, i) =>
  mockMakeStage(10 - i),
);
let mockLoading = false;
let mockError: string | null = null;
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
  loading: mockLoading,
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
  selectCycleNumber: () => 1,
}));

import styles from '../Map.styles';
import MapScreen from '../MapScreen';

type TestNode = { props: Record<string, unknown> };

describe('MapScreen — cold start and metadata edge cases', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLoadStages.mockClear();
    mockLoading = false;
    mockError = null;
    mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('shows the full-screen loader when no stages are cached yet', () => {
    mockLoading = true;
    mockStages = [];
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-loading' })).toBeTruthy();
  });

  it('shows the full-screen error when the load fails with nothing cached', () => {
    mockError = 'Could not reach the server.';
    mockStages = [];
    const tree = create(<MapScreen />);
    expect(tree.root.findByProps({ testID: 'map-error' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Could not reach the server.' })).toBeTruthy();
  });

  it('omits the free-will description line for a stage that has none', () => {
    mockStages = mockStages.map((s) =>
      s.stageNumber === 1 ? { ...s, freeWillDescription: '' } : s,
    );
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1-0' }).props.onPress();
    });
    expect(
      tree.root.findAll((node: TestNode) => node.props.style === styles.freeWillDescription),
    ).toHaveLength(0);
  });
});
