import { create } from 'zustand';

import type { StageData } from '../features/Map/stageData';

import { createNormalizedById } from './normalizedCollection';
import { registerStoreReset } from './registry';

/**
 * Stage store — a dumb state container. API calls live in
 * `features/Map/services/stageService.ts`; this module only holds and mutates
 * state.
 *
 * Canonical shape is `stagesByNumber` (keyed by `stageNumber`) plus
 * `stageOrder` for O(1) lookups while preserving the artwork-aligned ordering
 * (stage 10 → stage 1 = descending). The `stages` array is a derived cache
 * kept in sync by the mutation actions.
 */
export interface StageStoreState {
  /** `stageNumber` → StageData map. O(1) lookup for selectors. */
  stagesByNumber: Record<number, StageData>;
  /** Stage numbers in display order (descending: 10 first, 1 last). */
  stageOrder: number[];
  /** Derived array view. Kept in sync by actions. */
  stages: StageData[];
  currentStage: number;
  /** Which pass through the arc the user is on; 1 on a first walk-through. */
  cycleNumber: number;
  loading: boolean;
  error: string | null;
  /** Whether a stage load has been started at least once since the last reset. */
  hasAttempted: boolean;
  /**
   * Which load the store is currently listening to.
   *
   * Strictly increasing, and bumped by `reset()` as well as by `beginLoad()`,
   * so a request in flight when the user signs out can never match again --
   * were it merely returned to its initial value, the next session's first
   * load would reuse a number an abandoned request is still holding.
   */
  loadGeneration: number;

  setStages: (_stages: StageData[]) => void;
  setCurrentStage: (_stageNumber: number) => void;
  setCycleNumber: (_cycleNumber: number) => void;
  setLoading: (_loading: boolean) => void;
  setError: (_error: string | null) => void;
  markAttempted: () => void;
  /** Claim the store for a new request, returning the generation it must quote to write. */
  beginLoad: () => number;
  updateStageProgress: (_stageNumber: number, _progress: number) => void;
  /** BUG-FE-STATE-001: wipe every field back to its initial value on logout. */
  reset: () => void;
}

const INITIAL_STATE = {
  stagesByNumber: {} as Record<number, StageData>,
  stageOrder: [] as number[],
  stages: [] as StageData[],
  currentStage: 1,
  cycleNumber: 1,
  loading: false,
  error: null as string | null,
  hasAttempted: false,
  loadGeneration: 0,
};

const stageCollection = createNormalizedById<StageData>((stage) => stage.stageNumber);

const normalizeStages = (
  stages: StageData[],
): { stagesByNumber: Record<number, StageData>; stageOrder: number[]; stages: StageData[] } => {
  const { byId, order, list } = stageCollection.normalize(stages);
  return { stagesByNumber: byId, stageOrder: order, stages: list };
};

export const useStageStore = create<StageStoreState>((set, get) => ({
  ...INITIAL_STATE,

  setStages: (stages) => set(normalizeStages(stages)),
  setCurrentStage: (currentStage) => set({ currentStage }),
  setCycleNumber: (cycleNumber) => set({ cycleNumber }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  markAttempted: () => set({ hasAttempted: true }),
  beginLoad: () => {
    const loadGeneration = get().loadGeneration + 1;
    set({ loadGeneration });
    return loadGeneration;
  },
  updateStageProgress: (stageNumber, progress) =>
    set((state) => {
      const existing = state.stagesByNumber[stageNumber];
      if (!existing) {
        // BUG-FE-STATE-003: previously the unknown-stage branch silently
        // returned the same state object, masking contract drift between
        // the client's ``stagesByNumber`` (loaded once at sign-in) and a
        // backend that added a new stage.  Logging at ``warn`` keeps the
        // UI quiet (no thrown error, no broken render) while surfacing
        // the drift to Sentry / console reporters.
        console.warn('[useStageStore] updateStageProgress called for unknown stage', {
          stageNumber,
          progress,
        });
        return state;
      }
      const stagesByNumber = {
        ...state.stagesByNumber,
        [stageNumber]: { ...existing, progress },
      };
      return { stagesByNumber, stages: stageCollection.rebuild(stagesByNumber, state.stageOrder) };
    }),
  reset: () => set((state) => ({ ...INITIAL_STATE, loadGeneration: state.loadGeneration + 1 })),
}));

// BUG-FE-STATE-001
registerStoreReset(() => {
  useStageStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Selectors — narrow state subscriptions. Zustand compares the *value*
// returned with `Object.is`, so components re-render only when their slice
// changes. Prefer these over destructuring the whole store.
// ---------------------------------------------------------------------------

export const selectStages = (state: StageStoreState): StageData[] => state.stages;
export const selectCurrentStage = (state: StageStoreState): number => state.currentStage;
export const selectCycleNumber = (state: StageStoreState): number => state.cycleNumber;
export const selectStagesLoading = (state: StageStoreState): boolean => state.loading;
export const selectStagesError = (state: StageStoreState): string | null => state.error;
export const selectStagesAttempted = (state: StageStoreState): boolean => state.hasAttempted;
export const selectLoadGeneration = (state: StageStoreState): number => state.loadGeneration;
