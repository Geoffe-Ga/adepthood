/**
 * One line for a check-in's milestone toast (#3526, D18).
 *
 * The server names which run thresholds a check-in crossed; this picks the one
 * worth a line and words it as a fact about the person's own record. A run's
 * very first day is not a milestone, and nothing here says "streak".
 */
import type { CheckInMilestone } from '@/api';
import { formatStreakAdjective, type HabitPeriodKind } from '@/features/Habits/HabitUtils';

/** Runs shorter than this are the habit beginning, not a milestone. */
export const MIN_MILESTONE_RUN = 3;
/** One stage of the program, in days (a 21-day run is one full stage). */
export const STAGE_RUN_DAYS = 21;

const KIND_RANK: Record<CheckInMilestone['kind'] & string, number> = {
  comeback: 3,
  personal_best: 2,
  streak_milestone: 1,
  streak_started: 0,
};

const rank = (milestone: CheckInMilestone): number =>
  (milestone.label ? KIND_RANK.comeback + 1 : 0) + KIND_RANK[milestone.kind ?? 'streak_milestone'];

function wording(milestone: CheckInMilestone, habitName: string, period: HabitPeriodKind): string {
  if (milestone.label) return milestone.label;
  const run = `${formatStreakAdjective(milestone.threshold, period)} run`;
  if (milestone.kind === 'comeback') return `Back to ${habitName}. The record kept your place.`;
  if (milestone.kind === 'personal_best') return `The longest run of ${habitName} yet: a ${run}.`;
  if (period === 'day' && milestone.threshold === STAGE_RUN_DAYS)
    return `Twenty-one days. One full stage of ${habitName}.`;
  return `A ${run} of ${habitName}.`;
}

/** The single milestone line for a toast, or ``null`` when nothing crossed is worth one. */
export function milestoneLine(
  milestones: readonly CheckInMilestone[] | undefined,
  habitName: string,
  period: HabitPeriodKind,
): string | null {
  const worth = (milestones ?? []).filter(
    (milestone) =>
      milestone.label ||
      milestone.kind === 'comeback' ||
      (milestone.kind !== 'streak_started' && milestone.threshold >= MIN_MILESTONE_RUN),
  );
  const best = worth.reduce<CheckInMilestone | null>(
    (top, milestone) =>
      top === null ||
      rank(milestone) > rank(top) ||
      (rank(milestone) === rank(top) && milestone.threshold > top.threshold)
        ? milestone
        : top,
    null,
  );
  return best === null ? null : wording(best, habitName, period);
}
