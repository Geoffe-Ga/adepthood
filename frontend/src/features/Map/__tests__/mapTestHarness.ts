/* eslint-env jest */
/* global jest */
import type { StageData } from '../stageData';

/**
 * Shared Jest scaffold for the MapScreen-driven suites. Each suite keeps its
 * own ``jest.mock(...)`` calls (so it controls exactly which modules it mocks)
 * and points every factory at a builder here via
 * ``jest.requireActual('./mapTestHarness')`` — the factory then references only
 * the ``jest`` global and a string literal, satisfying babel-plugin-jest-hoist
 * regardless of import order. Per-test state lives on the shared ``mockMapState``
 * singleton, which the suites mutate through their imported binding (the same
 * cached module instance the factories resolve).
 */

/** Aggregated stage history, mirroring the ``/stages/{n}/history`` payload. */
export interface StageHistoryData {
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

/** Build a realistic StageData; ``overrides`` owns the per-test seam. */
export function mockMakeStage(stageNumber: number, overrides: Partial<StageData> = {}): StageData {
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

/** Ten stages, highest-numbered first (the store's render order). */
export function createDefaultStages(): StageData[] {
  return Array.from({ length: 10 }, (_, i) => mockMakeStage(10 - i));
}

type EndOfCycleMock = jest.Mock<boolean, [Record<number, { progress: number }>, number]>;

/** Mutable per-test knobs the mock builders read lazily at call time. */
export interface MapMockState {
  stages: StageData[];
  currentStage: number;
  loading: boolean;
  error: string | null;
  cycleNumber: number;
  derivedStage: number | null;
  derivedWeek: number | null;
  daysUntilStage: number | null;
  wheelFullnessByStage: Record<number, number>;
  wheelLoading: boolean;
  wheelError: string | null;
  isEndOfCycle: EndOfCycleMock;
}

function createDefaultState(): MapMockState {
  return {
    stages: createDefaultStages(),
    currentStage: 1,
    loading: false,
    error: null,
    cycleNumber: 1,
    derivedStage: 1,
    derivedWeek: 1,
    daysUntilStage: null,
    wheelFullnessByStage: {},
    wheelLoading: false,
    wheelError: null,
    isEndOfCycle: jest.fn<boolean, [Record<number, { progress: number }>, number]>(() => false),
  };
}

/** The shared, mutable state singleton every suite drives. */
export const mockMapState: MapMockState = createDefaultState();

/** Restore ``mockMapState`` to its defaults (fresh ``isEndOfCycle`` spy). */
export function resetMapMockState(): void {
  Object.assign(mockMapState, createDefaultState());
}

/** Navigation spy asserted by the suites; the navigation mock reads it. */
export const mockNavigate = jest.fn();
/** ``navigation.setOptions`` spy — surfaces the drawer's installed ``headerLeft``. */
export const mockSetOptions = jest.fn();
/** ``stageService.loadStages`` spy. */
export const mockLoadStages = jest.fn();
/** ``stageService.beginAgain`` spy. */
export const mockBeginAgain = jest.fn();

/** Reset state and clear the shared spies (call from ``beforeEach``). */
export function resetMapMocks(): void {
  resetMapMockState();
  mockNavigate.mockClear();
  mockSetOptions.mockClear();
  mockLoadStages.mockClear();
  mockBeginAgain.mockClear();
}

/** The single source of truth for the unlock rule, matching ``stageService``. */
export const mockIsStageUnlocked = (
  stage: { isUnlocked: boolean; stageNumber: number },
  currentStage: number | null,
): boolean => stage.isUnlocked || (currentStage !== null && stage.stageNumber <= currentStage);

/** Build the ``useStageStore`` state slice from the current ``mockMapState``. */
export function buildMockStageState() {
  const { stages, currentStage, loading, error, cycleNumber } = mockMapState;
  return {
    stages,
    stagesByNumber: Object.fromEntries(stages.map((s) => [s.stageNumber, s])),
    stageOrder: stages.map((s) => s.stageNumber),
    currentStage,
    loading,
    error,
    cycleNumber,
    setStages: jest.fn(),
    setCurrentStage: jest.fn(),
    setLoading: jest.fn(),
    setError: jest.fn(),
    updateStageProgress: jest.fn(),
    setCycleNumber: jest.fn(),
  };
}

// --- Module-mock builders. Each returns the shape of one mocked module; the
// suites wrap them in `jest.mock(path, () => requireActual(harness).builder())`.

/** ``react-native/Libraries/Interaction/InteractionManager`` — runs callbacks now. */
export function mockInteractionManagerModule() {
  return {
    runAfterInteractions: (cb: () => void) => {
      cb();
      return { then: () => {}, done: () => {}, cancel: () => {} };
    },
    createInteractionHandle: () => 1,
    clearInteractionHandle: () => {},
  };
}

/**
 * ``navigation/hooks`` — surfaces the shared ``mockNavigate`` / ``mockSetOptions``
 * spies. ``setOptions`` is read by ``useScreenDrawer`` (a header-left toggle
 * installed in a ``useLayoutEffect``); without it every screen that mounts a
 * drawer would crash reading ``setOptions`` off an undefined navigation object.
 */
export function mockNavigationModule() {
  return { useAppNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }) };
}

/** ``@react-navigation/bottom-tabs``. */
export function mockBottomTabsModule() {
  return { useBottomTabBarHeight: () => 0 };
}

/** ``react-native-safe-area-context``. */
export function mockSafeAreaModule() {
  return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
}

/** ``hooks/useWheelBalance`` — driven by ``mockMapState.wheel*``. */
export function mockWheelBalanceModule() {
  return {
    useWheelBalance: () => ({
      fullnessByStage: mockMapState.wheelFullnessByStage,
      loading: mockMapState.wheelLoading,
      error: mockMapState.wheelError,
    }),
  };
}

/** ``store/useProgramProgression`` — ``null`` knobs fall back to the call-site default. */
export function mockProgramProgressionModule() {
  return {
    useDerivedCurrentStage: (fallback: number) => mockMapState.derivedStage ?? fallback,
    useDerivedCurrentWeek: (fallback: number) => mockMapState.derivedWeek ?? fallback,
    useDaysUntilStage: () => mockMapState.daysUntilStage,
  };
}

/** ``services/stageService`` — spies plus the shared unlock/end-of-cycle logic. */
export function mockStageServiceModule() {
  return {
    stageService: {
      loadStages: (...args: unknown[]) => mockLoadStages(...args),
      beginAgain: (...args: unknown[]) => mockBeginAgain(...args),
    },
    isStageUnlocked: mockIsStageUnlocked,
    isEndOfCycle: (stagesByNumber: Record<number, { progress: number }>, currentStage: number) =>
      mockMapState.isEndOfCycle(stagesByNumber, currentStage),
  };
}

type MockStageState = ReturnType<typeof buildMockStageState>;

/** ``store/useStageStore`` — the hook plus every selector the suites consume. */
export function mockStageStoreModule() {
  return {
    useStageStore: jest.fn((selector?: (state: MockStageState) => unknown) => {
      const state = buildMockStageState();
      return selector ? selector(state) : state;
    }),
    selectStages: (s: { stages: unknown }) => s.stages,
    selectCurrentStage: (s: { currentStage: unknown }) => s.currentStage,
    selectStagesLoading: (s: { loading: unknown }) => s.loading,
    selectStagesError: (s: { error: unknown }) => s.error,
    selectCycleNumber: (s: { cycleNumber: number }) => s.cycleNumber,
    selectStageByNumber:
      (n: number | null | undefined) => (s: { stagesByNumber: Record<number, unknown> }) =>
        n == null ? undefined : s.stagesByNumber[n],
  };
}
