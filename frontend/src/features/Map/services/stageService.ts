/**
 * Stage service — orchestrates API calls for stages and writes the result into
 * `useStageStore`. This keeps API access out of the Zustand store, which is a
 * pure state container.
 *
 * Consumers should call `stageService.loadStages()` from hooks / effects and
 * read state via `useStageStore` selectors.
 */

import { stages as stagesApi } from '../../../api';
import type { Stage } from '../../../api';
import { STAGE_COLORS, STAGE_ORDER } from '../../../design/tokens';
import { useStageStore } from '../../../store/useStageStore';
import { HOTSPOTS, STAGE_COUNT } from '../stageData';
import type { StageData } from '../stageData';

/** Convert a backend Stage response into a frontend StageData with layout. */
export const toStageData = (apiStage: Stage): StageData => {
  const index = STAGE_COUNT - apiStage.stage_number; // stage 10 → index 0
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
};

/** First unlocked, still-in-progress stage; falls back to the last stage or 1. */
const pickCurrentStage = (apiStages: Stage[]): number =>
  apiStages.find((s) => s.is_unlocked && s.progress < 1)?.stage_number ??
  apiStages.at(-1)?.stage_number ??
  1;

export const stageService = {
  /**
   * Fetch the stage list, map to StageData, and write it into the store. On
   * failure, leaves existing state in place and records an error message.
   */
  loadStages: async (token?: string): Promise<void> => {
    const store = useStageStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const apiStages = await stagesApi.list(token);
      // Sort descending by stage_number (10 at top, 1 at bottom) to match
      // the background artwork.
      const sorted = [...apiStages].sort((a, b) => b.stage_number - a.stage_number);
      useStageStore.getState().setStages(sorted.map(toStageData));
      useStageStore.getState().setCurrentStage(pickCurrentStage(sorted));
      useStageStore.getState().setLoading(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stages';
      useStageStore.getState().setError(message);
      useStageStore.getState().setLoading(false);
    }
  },
};

export type StageService = typeof stageService;
