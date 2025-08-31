// app/features/Map/stageData.ts

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

// Rough percentage-based hotspot layout matching the spiral image. Each stage has
// two tappable regions: the colored text on the left and the arrow in the
// middle. Adjust these values when the final background asset is available.
const HOTSPOTS: Hotspot[][] = [
  [
    { top: 8, left: 4, width: 32, height: 8 },
    { top: 8, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 16, left: 4, width: 32, height: 8 },
    { top: 16, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 24, left: 4, width: 32, height: 8 },
    { top: 24, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 32, left: 4, width: 32, height: 8 },
    { top: 32, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 40, left: 4, width: 32, height: 8 },
    { top: 40, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 48, left: 4, width: 32, height: 8 },
    { top: 48, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 56, left: 4, width: 32, height: 8 },
    { top: 56, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 64, left: 4, width: 32, height: 8 },
    { top: 64, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 72, left: 4, width: 32, height: 8 },
    { top: 72, left: 42, width: 32, height: 8 },
  ],
  [
    { top: 80, left: 4, width: 32, height: 8 },
    { top: 80, left: 42, width: 32, height: 8 },
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
