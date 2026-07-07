import type { Stage } from '../api';

/** Total number of APTITUDE stages. */
export const STAGE_COUNT = 10;

export const FULLY_COMPLETE = 1;

/**
 * Count-based current-stage derivation.
 *
 * Mirrors the backend's `next_stage_for(user)` under the chain-validation
 * invariant: `current = completed + 1`.  A fresh user with nothing completed
 * gets stage 1; each completed stage advances `current` by one, clamped to
 * the catalog range.  This replaces the old "first unlocked, still-in-
 * progress" heuristic which silently drifted to `max(stage_number)` over
 * unlocked rows when the backend's `is_unlocked` flag was ahead of
 * completion.
 */
export const deriveCurrentStage = (apiStages: Stage[]): number => {
  if (apiStages.length === 0) return 1;
  const completed = apiStages.filter((s) => s.progress >= FULLY_COMPLETE).length;
  return Math.min(Math.max(1, completed + 1), STAGE_COUNT);
};
