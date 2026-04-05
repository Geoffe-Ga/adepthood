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

// Percentage-based hotspot layout matching the spiral image. Each stage has a
// tappable region over the colored text on the left and another over its spiral
// arrow. Arrows alternate sides as the spiral winds; stage 9 has two arrows.
// Indexed 0–9 where index 0 = stage 10 (top) and index 9 = stage 1 (bottom).
export const HOTSPOTS: readonly Hotspot[][] = [
  [
    { top: 4, left: 4, width: 32, height: 6 },
    { top: 4, left: 34, width: 40, height: 6 },
  ],
  [
    { top: 12, left: 4, width: 32, height: 6 },
    { top: 12, left: 34, width: 40, height: 6 },
    { top: 12, left: 50, width: 40, height: 6 },
  ],
  [
    { top: 20, left: 4, width: 32, height: 6 },
    { top: 20, left: 34, width: 40, height: 6 },
  ],
  [
    { top: 28, left: 4, width: 32, height: 6 },
    { top: 28, left: 50, width: 40, height: 6 },
  ],
  [
    { top: 36, left: 4, width: 32, height: 6 },
    { top: 36, left: 34, width: 40, height: 6 },
  ],
  [
    { top: 44, left: 4, width: 32, height: 6 },
    { top: 44, left: 50, width: 40, height: 6 },
  ],
  [
    { top: 52, left: 4, width: 32, height: 6 },
    { top: 52, left: 34, width: 40, height: 6 },
  ],
  [
    { top: 60, left: 4, width: 32, height: 6 },
    { top: 60, left: 50, width: 40, height: 6 },
  ],
  [
    { top: 68, left: 4, width: 32, height: 6 },
    { top: 68, left: 34, width: 40, height: 6 },
  ],
  [
    { top: 76, left: 4, width: 32, height: 6 },
    { top: 76, left: 50, width: 40, height: 6 },
  ],
] as const;

/** Total number of APTITUDE stages. */
export const STAGE_COUNT = 10;
