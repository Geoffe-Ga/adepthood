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
}

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
  };
});
