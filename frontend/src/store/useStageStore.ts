import { create } from 'zustand';

import { STAGES } from '../features/Map/stageData';
import type { StageData } from '../features/Map/stageData';

/* eslint-disable no-unused-vars */
export interface StageStoreState {
  stages: StageData[];
  currentStage: number;

  setStages: (_stages: StageData[]) => void;
  setCurrentStage: (_stageNumber: number) => void;
  updateStageProgress: (_stageNumber: number, _progress: number) => void;
}
/* eslint-enable no-unused-vars */

export const useStageStore = create<StageStoreState>((set) => ({
  stages: STAGES,
  currentStage: 1,

  setStages: (stages) => set({ stages }),
  setCurrentStage: (currentStage) => set({ currentStage }),
  updateStageProgress: (stageNumber, progress) =>
    set((state) => ({
      stages: state.stages.map((s) =>
        s.stageNumber === stageNumber ? { ...s, progress } : s,
      ),
    })),
}));
