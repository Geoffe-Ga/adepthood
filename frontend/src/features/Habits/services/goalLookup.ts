/**
 * Finding a goal in the habit store by its id, safely.
 *
 * The store indexes habits, not goals, so a `goal_id` lookup is a scan over
 * `habits[].goals[]` — the same shape `habitManager` already uses. What makes
 * it more than a scan is that a goal id alone names nothing reliably:
 * onboarding mints goal ids `1..3n`, byte-identical to the ids the server
 * issues, and demo tiles fabricate theirs outright (see `./serverIds`). A bare
 * id match can therefore return a placeholder row's unit, and the journal offer
 * card would ask the writer to consent to "64 glasses" while the server logs
 * ounces.
 *
 * So the predicate is the existing composed one, `isServerBackedGoal`, which
 * asks the parent habit for both provenance markers *and* the id shape. Do not
 * re-compose it here from its parts: dropping the id-shape half lets a row
 * cached by a build predating the marker — negative placeholder id, no
 * `hasClientMintedIds` — answer for the real goal.
 */
import { isServerBackedGoal } from './serverIds';

import type { Habit } from '@/features/Habits/Habits.types';

/**
 * The `target_unit` of the server-backed goal with this id, or `null`.
 *
 * `null` covers every "cannot honestly answer" case: no id, no such goal
 * loaded, or a goal that exists only on this device.
 *
 * @param habits - The store's habits, in any order.
 * @param goalId - The goal the caller holds an id for.
 * @returns The unit the server will log in, or `null`.
 */
export const findServerBackedGoalUnit = (
  habits: readonly Habit[],
  goalId: number | null | undefined,
): string | null => {
  if (goalId == null) return null;
  for (const habit of habits) {
    for (const goal of habit.goals) {
      if (goal.id === goalId && isServerBackedGoal(goal, habit)) return goal.target_unit;
    }
  }
  return null;
};
