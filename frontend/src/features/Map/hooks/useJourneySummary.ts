/**
 * Shared journey read for the Map header and its drawer legend, so the two
 * surfaces can never drift: identical week derivation, the same "Stage N of 10 ·
 * Week W" sentence, and the same past-first-pass cycle caption. Each surface
 * keeps its own styling; only the derived strings live here.
 */

import { useDerivedCurrentWeek } from '../../../store/useProgramProgression';
import { cycleLabel } from '../beginAgain';
import { journeyRead } from '../journeyNarrative';
import { STAGE_COUNT } from '../stageData';

/** The first pass through the arc earns no cycle caption; later passes name it. */
const FIRST_CYCLE = 1;

/** Fallback week before progression has a computed start date. */
const FALLBACK_WEEK = 1;

/** Derived journey strings shared by the Map header and the drawer legend. */
export interface JourneySummaryRead {
  /** "Stage N of 10 · Week W" progression sentence. */
  read: string;
  /** Cycle caption once past the first pass, else null. */
  cycleCaption: string | null;
}

/** Computes the journey read + cycle caption for a stage and cycle number. */
export function useJourneySummary(currentStage: number, cycleNumber: number): JourneySummaryRead {
  const week = useDerivedCurrentWeek(FALLBACK_WEEK);
  return {
    read: journeyRead(currentStage, week, STAGE_COUNT),
    cycleCaption: cycleNumber > FIRST_CYCLE ? cycleLabel(cycleNumber) : null,
  };
}
