import { create } from 'zustand';

import { stages as stagesApi } from '../api';
import type { Stage } from '../api';
import { STAGE_COLORS, STAGE_ORDER } from '../design/tokens';
import { HOTSPOTS, STAGE_COUNT } from '../features/Map/stageData';
import type { StageData } from '../features/Map/stageData';

/** Convert a backend Stage response into a frontend StageData with hotspot layout. */
function toStageData(apiStage: Stage): StageData {
  const index = STAGE_COUNT - apiStage.stage_number; // stage 10 = index 0
  const colorName = STAGE_ORDER[apiStage.stage_number - 1] ?? 'Beige';
  return {
    id: apiStage.id,
    title: apiStage.title,
    subtitle: apiStage.subtitle,
    stageNumber: apiStage.stage_number,
    progress: apiStage.progress,
    color: STAGE_COLORS[colorName] ?? '#888',
    isUnlocked: apiStage.is_unlocked,
    category: apiStage.category,
    aspect: apiStage.aspect,
    spiralDynamicsColor: apiStage.spiral_dynamics_color,
    growingUpStage: apiStage.growing_up_stage,
    divineGenderPolarity: apiStage.divine_gender_polarity,
    relationshipToFreeWill: apiStage.relationship_to_free_will,
    freeWillDescription: apiStage.free_will_description,
    overviewUrl: apiStage.overview_url,
    hotspots: [...(HOTSPOTS[index] ?? [])],
  };
}

/* eslint-disable no-unused-vars */
export interface StageStoreState {
  stages: StageData[];
  currentStage: number;
  loading: boolean;
  error: string | null;

  setStages: (_stages: StageData[]) => void;
  setCurrentStage: (_stageNumber: number) => void;
  updateStageProgress: (_stageNumber: number, _progress: number) => void;
  fetchStages: (_token?: string) => Promise<void>;
}
/* eslint-enable no-unused-vars */

export const useStageStore = create<StageStoreState>((set) => ({
  stages: [],
  currentStage: 1,
  loading: false,
  error: null,

  setStages: (stages) => set({ stages }),
  setCurrentStage: (currentStage) => set({ currentStage }),
  updateStageProgress: (stageNumber, progress) =>
    set((state) => ({
      stages: state.stages.map((s) => (s.stageNumber === stageNumber ? { ...s, progress } : s)),
    })),
  fetchStages: async (token?: string) => {
    set({ loading: true, error: null });
    try {
      const apiStages = await stagesApi.list(token);
      // Sort descending by stage_number (10 at top, 1 at bottom) to match artwork
      const sorted = [...apiStages].sort((a, b) => b.stage_number - a.stage_number);
      const mapped = sorted.map(toStageData);
      const current =
        sorted.find((s) => s.is_unlocked && s.progress < 1)?.stage_number ??
        sorted.at(-1)?.stage_number ??
        1;
      set({ stages: mapped, currentStage: current, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stages';
      set({ loading: false, error: message });
    }
  },
}));
