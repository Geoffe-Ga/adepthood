import { create } from 'zustand';

import type { StageData } from '../features/Map/stageData';

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
  loading: boolean;
  error: string | null;

  setStages: (_stages: StageData[]) => void;
  setCurrentStage: (_stageNumber: number) => void;
  setLoading: (_loading: boolean) => void;
  setError: (_error: string | null) => void;
  updateStageProgress: (_stageNumber: number, _progress: number) => void;
}

interface NormalizedStages {
  stagesByNumber: Record<number, StageData>;
  stageOrder: number[];
  stages: StageData[];
}

const normalizeStages = (stages: StageData[]): NormalizedStages => {
  const stagesByNumber: Record<number, StageData> = {};
  const stageOrder: number[] = [];
  for (const stage of stages) {
    stagesByNumber[stage.stageNumber] = stage;
    stageOrder.push(stage.stageNumber);
  }
  return { stagesByNumber, stageOrder, stages: [...stages] };
};

const rebuildStageList = (
  stagesByNumber: Record<number, StageData>,
  stageOrder: number[],
): StageData[] =>
  stageOrder.map((num) => stagesByNumber[num]!).filter((s): s is StageData => s !== undefined);

export const useStageStore = create<StageStoreState>((set) => ({
  stagesByNumber: {},
  stageOrder: [],
  stages: [],
  currentStage: 1,
  loading: false,
  error: null,

  setStages: (stages) => set(normalizeStages(stages)),
  setCurrentStage: (currentStage) => set({ currentStage }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  updateStageProgress: (stageNumber, progress) =>
    set((state) => {
      const existing = state.stagesByNumber[stageNumber];
      if (!existing) return state;
      const stagesByNumber = {
        ...state.stagesByNumber,
        [stageNumber]: { ...existing, progress },
      };
      return { stagesByNumber, stages: rebuildStageList(stagesByNumber, state.stageOrder) };
    }),
}));

// ---------------------------------------------------------------------------
// Selectors — narrow state subscriptions. Zustand compares the *value*
// returned with `Object.is`, so components re-render only when their slice
// changes. Prefer these over destructuring the whole store.
// ---------------------------------------------------------------------------

export const selectStages = (state: StageStoreState): StageData[] => state.stages;
export const selectCurrentStage = (state: StageStoreState): number => state.currentStage;
export const selectStagesLoading = (state: StageStoreState): boolean => state.loading;
export const selectStagesError = (state: StageStoreState): string | null => state.error;

export const selectStageByNumber =
  (stageNumber: number | null | undefined) =>
  (state: StageStoreState): StageData | undefined =>
    stageNumber == null ? undefined : state.stagesByNumber[stageNumber];
