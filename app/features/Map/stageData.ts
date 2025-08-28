// app/features/Map/stageData.ts

/**
 * Static placeholder data for the ten APTITUDE stages.
 * In a full implementation these would be fetched from the backend `CourseStage` model.
 */
export interface StageData {
  id: number;
  title: string;
  subtitle: string;
  stageNumber: number;
  progress: number; // 0–1 completion percentage
  goals: string[];
  practices: string[];
  color: string;
  position: { top: number; left: number };
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

const POSITIONS = [
  { top: 8, left: 10 },
  { top: 16, left: 60 },
  { top: 24, left: 10 },
  { top: 32, left: 60 },
  { top: 40, left: 10 },
  { top: 48, left: 60 },
  { top: 56, left: 10 },
  { top: 64, left: 60 },
  { top: 72, left: 10 },
  { top: 80, left: 60 },
] as const;

export const STAGES: StageData[] = Array.from({ length: 10 }, (_, index) => {
  const stageNumber = index + 1;
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stageNumber,
    // Simple demo progress – first stage partially complete, others locked
    progress: stageNumber === 1 ? 0.5 : 0,
    goals: [`Goal for stage ${stageNumber}`],
    practices: [`Practice for stage ${stageNumber}`],
    color: COLORS[index]!,
    position: POSITIONS[index]!,
  };
});
