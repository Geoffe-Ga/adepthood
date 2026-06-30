// React hooks layered on useProgramStore so consumers get a single render-friendly value plus a server-derived fallback.
import { useProgramStore, daysUntilStage, programStage, programWeek } from './useProgramStore';

export const useDerivedCurrentStage = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programStage(anchor, today) ?? fallback;
};

export const useDerivedCurrentWeek = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programWeek(anchor, today) ?? fallback;
};

// Whole days until ``stageNumber`` unlocks on the calendar, or null when no anchor is set.
export const useDaysUntilStage = (stageNumber: number, today: Date = new Date()): number | null => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return daysUntilStage(stageNumber, anchor, today);
};
