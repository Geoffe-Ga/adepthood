// frontend/features/Map/stageData.ts

/**
 * Type definitions and shared geometry helpers for the Map screen.
 *
 * The Map is laid out by a single responsive row grid (see ``MapGrid`` in
 * ``MapScreen``); there is no longer any absolute-percentage coordinate system
 * here. Stage *content* is fetched from the backend API.
 */

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
}

/** Total number of APTITUDE stages. */
export const STAGE_COUNT = 10;

/**
 * Which way a stage's spiral arrow winds. Even (Divine-Feminine) stages return
 * along the left; odd stages point right. This is the spiral's *meaning* — the
 * arrow glyph reads from it directly, so the Map is legible with no PNG (#766).
 */
export const isLeftReturning = (stageNumber: number): boolean => stageNumber % 2 === 0;
