import { create } from 'zustand';

import type { StageData } from '../features/Map/stageData';

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
  loading: boolean;
  error: string | null;

  setStages: (_stages: StageData[]) => void;
  setCurrentStage: (_stageNumber: number) => void;
  setLoading: (_loading: boolean) => void;
  setError: (_error: string | null) => void;
  updateStageProgress: (_stageNumber: number, _progress: number) => void;
  /** BUG-FE-STATE-001: wipe every field back to its initial value on logout. */
  reset: () => void;
}

const INITIAL_STATE = {
  stagesByNumber: {} as Record<number, StageData>,
  stageOrder: [] as number[],
  stages: [] as StageData[],
  currentStage: 1,
  loading: false,
  error: null as string | null,
};

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
  ...INITIAL_STATE,

  setStages: (stages) => set(normalizeStages(stages)),
  setCurrentStage: (currentStage) => set({ currentStage }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
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
      return { stagesByNumber, stages: rebuildStageList(stagesByNumber, state.stageOrder) };
    }),
  reset: () => set({ ...INITIAL_STATE }),
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
export const selectStagesLoading = (state: StageStoreState): boolean => state.loading;
export const selectStagesError = (state: StageStoreState): string | null => state.error;

// BUG-FE-STATE-002: memoize per stage number so repeat
// ``useStageStore(selectStageByNumber(n))`` calls return the SAME
// closure and Zustand's internal slice ref stays warm.  Without the
// cache, every render minted a fresh selector and Zustand re-subscribed
// the store with one extra forced render per id change.
const NULL_STAGE_SELECTOR = (_state: StageStoreState): StageData | undefined => undefined;
const stageByNumberSelectorCache = new Map<
  number,
  (_state: StageStoreState) => StageData | undefined
>();

export const selectStageByNumber = (
  stageNumber: number | null | undefined,
): ((_state: StageStoreState) => StageData | undefined) => {
  if (stageNumber == null) return NULL_STAGE_SELECTOR;
  let cached = stageByNumberSelectorCache.get(stageNumber);
  if (cached === undefined) {
    cached = (state: StageStoreState) => state.stagesByNumber[stageNumber];
    stageByNumberSelectorCache.set(stageNumber, cached);
  }
  return cached;
};
