// frontend/features/Map/stageData.ts

/**
 * Type definitions and shared geometry helpers for the Map screen.
 *
 * The Map is laid out by a single responsive row grid (see ``MapGrid`` in
 * ``MapScreen``); there is no longer any absolute-percentage coordinate system
 * here. Stage *content* is fetched from the backend API.
 */

import type { StageManifestation } from '../../api';

export { STAGE_COUNT } from '../../domain/stageProgression';
export type { StageExpression, StageManifestation } from '../../api';

export interface StageData {
  id: number;
  title: string;
  subtitle: string;
  stageNumber: number;
  progress: number; // 0–1 completion percentage
  color: string;
  isUnlocked: boolean;
  // Rich metadata from backend
  category: string;
  aspect: string;
  spiralDynamicsColor: string;
  growingUpStage: string;
  divineGenderPolarity: string;
  relationshipToFreeWill: string;
  freeWillDescription: string;
  overviewUrl: string;
  // How this stage manifests across the six Wavelength phases (integrated +
  // shadow); an empty array when the backend omits the field.
  manifestations: StageManifestation[];
}

/**
 * Which way a stage's spiral arrow winds. Even (Divine-Feminine) stages return
 * along the left; odd stages point right. This is the spiral's *meaning* — the
 * arrow glyph reads from it directly, so the Map is legible with no PNG (#766).
 */
export const isLeftReturning = (stageNumber: number): boolean => stageNumber % 2 === 0;
