import type { StageData } from '@/features/Map/stageData';
import { useStageStore } from '@/store/useStageStore';

/**
 * Fill the stage store as if ``GET /stages`` had served these colour names.
 *
 * The served-first colour-name readers (``store/stageColorName.ts``) take a
 * stage's Spiral colour from the store before the pinned offline fallback, so a
 * test proving that order needs a store holding a colour the fallback would not
 * give. Only the colour is meaningful here; every other field is inert filler
 * that keeps the ``StageData`` type whole.
 */
export function serveStageColors(colorByStage: Readonly<Record<number, string>>): void {
  useStageStore.getState().setStages(
    Object.entries(colorByStage).map(([stageNumber, spiralDynamicsColor]): StageData => ({
      id: Number(stageNumber),
      title: '',
      subtitle: '',
      stageNumber: Number(stageNumber),
      progress: 0,
      color: '',
      isUnlocked: true,
      category: '',
      aspect: '',
      spiralDynamicsColor,
      growingUpStage: '',
      divineGenderPolarity: '',
      relationshipToFreeWill: '',
      freeWillDescription: '',
      overviewUrl: '',
      manifestations: [],
      mode: null,
      chord: [],
    })),
  );
}

/** Empty the stage store again, so no served colour leaks into the next test. */
export function clearServedStages(): void {
  useStageStore.getState().reset();
}
