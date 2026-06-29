// frontend/features/Map/stageData.ts

/**
 * Type definitions and static hotspot layout for the Map screen.
 * Stage content is fetched from the backend API — only tap-target
 * geometry remains hardcoded since it maps to the background artwork.
 */

export interface Hotspot {
  top: number;
  left: number;
  width: number;
  height: number;
}

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
  hotspots: Hotspot[]; // areas that respond to taps
}

/** Total number of APTITUDE stages. */
export const STAGE_COUNT = 10;

// --- Arrow tap-target geometry ---------------------------------------------
// The center column shows the colored-arrow spiral PNG. Each stage gets one
// tappable band over its arrow loop, expressed as a percentage of the *center
// column* (not the whole screen). The ten loops are evenly stacked top→bottom,
// alternating sides as the spiral winds: even (Divine-Feminine) stages return
// along the left, odd stages point right. Tune these against the final artwork.

/** Height of one arrow band as a % of the column (ten evenly-spaced loops). */
const ARROW_BAND_HEIGHT = 100 / STAGE_COUNT;
/** Vertical inset so adjacent bands never touch / overlap. */
const ARROW_BAND_INSET = 1;
/** Horizontal extent of an arrow loop, as a % of the column width. */
const ARROW_WIDTH = 46;
/** Left edge of a left-returning (Divine-Feminine) arrow loop. */
const ARROW_LEFT_X = 4;
/** Left edge of a right-pointing arrow loop. */
const ARROW_RIGHT_X = 50;

const isLeftReturning = (stageNumber: number): boolean => stageNumber % 2 === 0;

/**
 * Percentage-based arrow hotspots, one band per stage. Indexed 0–9 where
 * index 0 = stage 10 (top) and index 9 = stage 1 (bottom), matching the
 * descending sort applied to the backend stage list.
 */
export const HOTSPOTS: readonly Hotspot[][] = Array.from({ length: STAGE_COUNT }, (_, index) => {
  const stageNumber = STAGE_COUNT - index;
  return [
    {
      top: index * ARROW_BAND_HEIGHT + ARROW_BAND_INSET,
      left: isLeftReturning(stageNumber) ? ARROW_LEFT_X : ARROW_RIGHT_X,
      width: ARROW_WIDTH,
      height: ARROW_BAND_HEIGHT - ARROW_BAND_INSET * 2,
    },
  ];
});
