/**
 * React hooks for date-driven program progression.
 *
 * These wrap ``useProgramStore`` so consumers can ask for the current
 * stage or current week as a single render-friendly value, with a
 * ``fallback`` to use when the user has not yet picked a master anchor.
 *
 * Splitting these out of ``useProgramStore`` keeps the store file a pure
 * state container (the project's convention) and gives feature code a
 * stable entry point that can be unit-tested in isolation from the
 * date-arithmetic helpers.
 */

import { useProgramStore, programStage, programWeek } from './useProgramStore';

/**
 * Return the date-derived current stage (1-10), or ``fallback`` when no
 * program anchor is set.  ``today`` defaults to ``new Date()`` -- pass
 * an explicit value in tests to avoid clock dependence.
 */
export const useDerivedCurrentStage = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programStage(anchor, today) ?? fallback;
};

/**
 * Return the date-derived current week (1-36), or ``fallback`` when no
 * program anchor is set.
 */
export const useDerivedCurrentWeek = (fallback: number, today: Date = new Date()): number => {
  const anchor = useProgramStore((s) => s.programStartDate);
  return programWeek(anchor, today) ?? fallback;
};
