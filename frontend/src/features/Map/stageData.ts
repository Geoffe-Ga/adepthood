// frontend/features/Map/stageData.ts

/**
 * Static placeholder data for the ten APTITUDE stages.
 * In a full implementation these would be fetched from the backend `CourseStage` model.
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
  goals: string[];
  practices: string[];
  color: string;
  hotspots: Hotspot[]; // areas that respond to taps
}

const COLORS = [
  '#7f1d1d',
  '#9f1239',
  '#c026d3',
  '#6d28d9',
  '#1d4ed8',
  '#0ea5e9',
  '#059669',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
];

// Percentage-based hotspot layout matching the spiral image. Each stage has a
// tappable region over the colored text on the left and another over its spiral
// arrow. Arrows alternate sides as the spiral winds; stage 9 has two arrows.
const HOTSPOTS: Hotspot[][] = [
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

// Stages are ordered from top (stage 10) to bottom (stage 1) to match the
// background artwork where the spiral begins with 10 at the top and ends with
// 1 at the bottom.
export const STAGES: StageData[] = Array.from({ length: 10 }, (_, index) => {
  const stageNumber = 10 - index;
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    // Simple demo progress – first stage partially complete, others locked
    progress: stageNumber === 1 ? 0.5 : 0,
    goals: [`Goal for stage ${stageNumber}`],
    practices: [`Practice for stage ${stageNumber}`],
    color: COLORS[stageNumber - 1]!,
    hotspots: HOTSPOTS[index]!,
  };
});
