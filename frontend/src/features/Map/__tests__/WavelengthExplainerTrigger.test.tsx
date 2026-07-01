/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
// Pins the MapScreen JourneyHeader trigger contract: a TouchableOpacity with
// testID="wavelength-explainer-trigger", accessibilityRole="button", and an
// accessibilityLabel like "How the Wavelength works" that opens
// WavelengthExplainer. The explainer must never be visible on initial render.
import React from 'react';
import { Image } from 'react-native';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

jest.mock('react-native/Libraries/Interaction/InteractionManager', () => ({
  runAfterInteractions: (cb: () => void) => {
    cb();
    return { then: () => {}, done: () => {}, cancel: () => {} };
  },
  createInteractionHandle: () => 1,
  clearInteractionHandle: () => {},
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

let mockWheelFullnessByStage: Record<number, number> = {};
jest.mock('../hooks/useWheelBalance', () => ({
  useWheelBalance: () => ({
    fullnessByStage: mockWheelFullnessByStage,
    loading: false,
    error: null,
  }),
}));

let mockDerivedStage = 1;
jest.mock('../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (fallback: number) => mockDerivedStage ?? fallback,
  useDerivedCurrentWeek: (fallback: number) => fallback,
  useDaysUntilStage: () => null,
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
    freeWillDescription: 'Description of free will.',
    overviewUrl: '',
    hotspots: [
      { top: (10 - stageNumber) * 8 + 4, left: 4, width: 32, height: 6 },
      { top: (10 - stageNumber) * 8 + 4, left: 34, width: 40, height: 6 },
    ],
  };
}

const mockStages = Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));

jest.mock('../services/stageService', () => ({
  stageService: {
    loadStages: jest.fn(),
    beginAgain: jest.fn(),
  },
  isStageUnlocked: (
    stage: { isUnlocked: boolean; stageNumber: number },
    currentStage: number | null,
  ) => stage.isUnlocked || (currentStage !== null && stage.stageNumber <= currentStage),
  isEndOfCycle: () => false,
}));

const buildMockStageState = () => ({
  stages: mockStages,
  stagesByNumber: Object.fromEntries(mockStages.map((s) => [s.stageNumber, s])),
  stageOrder: mockStages.map((s) => s.stageNumber),
  currentStage: 1,
  loading: false,
  error: null,
  cycleNumber: 1,
  setStages: jest.fn(),
  setCurrentStage: jest.fn(),
  setLoading: jest.fn(),
  setError: jest.fn(),
  updateStageProgress: jest.fn(),
  setCycleNumber: jest.fn(),
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
  selectCycleNumber: (s: { cycleNumber: number }) => s.cycleNumber,
  selectStageByNumber:
    (n: number | null | undefined) => (s: { stagesByNumber: Record<number, unknown> }) =>
      n == null ? undefined : s.stagesByNumber[n],
}));

type TestNode = { props: Record<string, unknown> };

describe('MapScreen wavelength explainer trigger', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockDerivedStage = 1;
    mockWheelFullnessByStage = {};
    jest.spyOn(Image, 'getSize').mockImplementation((_, success) => success(100, 200));
  });

  it('does not show the explainer on initial render', () => {
    const tree = create(<MapScreen />);
    expect(
      tree.root.findAll((n: TestNode) => n.props.testID === 'wavelength-explainer'),
    ).toHaveLength(0);
  });

  it('renders the trigger in the journey header with an accessible label', () => {
    const tree = create(<MapScreen />);
    const trigger = tree.root.findByProps({ testID: 'wavelength-explainer-trigger' });
    expect(trigger.props.accessibilityRole).toBe('button');
    expect(trigger.props.accessibilityLabel).toMatch(/wavelength/i);
  });

  it('opens the explainer when the trigger is pressed', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'wavelength-explainer-trigger' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'wavelength-explainer' })).toBeTruthy();
  });

  it('dismisses the explainer when the close affordance is pressed', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'wavelength-explainer-trigger' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'wavelength-explainer-close' }).props.onPress();
    });
    expect(
      tree.root.findAll((n: TestNode) => n.props.testID === 'wavelength-explainer'),
    ).toHaveLength(0);
  });
});
