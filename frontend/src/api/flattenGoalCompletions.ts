import type { Completion } from '@/features/Habits/Habits.types';

/** Structural shape so callers pass an ``ApiGoal[]`` slice without a cast. */
export interface GoalWithEmbeddedCompletions {
  completions?: ReadonlyArray<{
    id: number;
    timestamp: string;
    completed_units: number;
  }> | null;
}

/** Flatten + dedupe per-goal completions into the habit-level shape. */
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
