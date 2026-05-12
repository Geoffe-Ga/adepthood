// React hooks layered on useProgramStore so consumers get a single render-friendly value plus a server-derived fallback.
import { useProgramStore, programStage, programWeek } from './useProgramStore';

export const useDerivedCurrentStage = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programStage(anchor, today) ?? fallback;
};

export const useDerivedCurrentWeek = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programWeek(anchor, today) ?? fallback;
};
