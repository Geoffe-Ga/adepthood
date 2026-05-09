/**
 * Flatten a habit's per-goal completions into the local
 * :class:`Completion` shape (BUG-FE-HABIT-301).
 *
 * The frontend models progress at the habit level (sum of all completed
 * units across the habit's goals), but the backend stores completions on
 * the ``Goal`` row.  This helper concatenates the embedded lists into a
 * single array, dedupes by row id (a future shared-goal feature could
 * surface the same row under multiple tier goals), and rehydrates ISO
 * timestamps to ``Date`` objects.
 *
 * Lives at the API-mapper boundary so both the bare ``toLocalHabit``
 * (api/index.ts) and the store-level ``mapApiHabits``
 * (features/Habits/services/habitManager.ts) call the same
 * implementation.  Duplicating the loop in both files would defeat the
 * point of the persistence fix at the data layer by re-introducing the
 * same divergence risk at the client layer -- the reviewer flagged the
 * duplication on the first cut and the extracted helper closes that gap.
 */
import type { Completion } from '@/features/Habits/Habits.types';

/**
 * Structural shape of a goal embedding completions, deliberately
 * narrower than ``ApiGoal`` so callers can pass either ``ApiGoal[]`` or
 * the inferred ``habitsApi.list()[number]['goals']`` slice without an
 * explicit cast.
 */
export interface GoalWithEmbeddedCompletions {
  completions?: ReadonlyArray<{
    id: number;
    timestamp: string;
    completed_units: number;
  }> | null;
}

export function flattenGoalCompletions(
  goals: ReadonlyArray<GoalWithEmbeddedCompletions>,
): Completion[] {
  const seen = new Set<number>();
  const flat: Completion[] = [];
  for (const goal of goals) {
    for (const c of goal.completions ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      flat.push({
        id: String(c.id),
        timestamp: new Date(c.timestamp),
        completed_units: c.completed_units,
      });
    }
  }
  return flat;
}
