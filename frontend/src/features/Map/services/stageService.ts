/**
 * Stage service — orchestrates API calls for stages and writes the result into
 * `useStageStore`. This keeps API access out of the Zustand store, which is a
 * pure state container.
 *
 * Consumers should call `stageService.loadStages()` from hooks / effects and
 * read state via `useStageStore` selectors.
 */

import { stages as stagesApi } from '../../../api';
import type { Stage } from '../../../api';
import { STAGE_COLORS, STAGE_ORDER } from '../../../design/tokens';
import { useStageStore } from '../../../store/useStageStore';
import { HOTSPOTS, STAGE_COUNT } from '../stageData';
import type { StageData } from '../stageData';

/** Convert a backend Stage response into a frontend StageData with layout. */
export const toStageData = (apiStage: Stage): StageData => {
  const index = STAGE_COUNT - apiStage.stage_number; // stage 10 → index 0
  const colorName = STAGE_ORDER[apiStage.stage_number - 1] ?? 'Beige';
  return {
    id: apiStage.id,
    title: apiStage.title,
    subtitle: apiStage.subtitle,
    stageNumber: apiStage.stage_number,
    progress: apiStage.progress,
    color: STAGE_COLORS[colorName] ?? '#888',
    isUnlocked: apiStage.is_unlocked,
    category: apiStage.category,
    aspect: apiStage.aspect,
    spiralDynamicsColor: apiStage.spiral_dynamics_color,
    growingUpStage: apiStage.growing_up_stage,
    divineGenderPolarity: apiStage.divine_gender_polarity,
    relationshipToFreeWill: apiStage.relationship_to_free_will,
    freeWillDescription: apiStage.free_will_description,
    overviewUrl: apiStage.overview_url,
    hotspots: [...(HOTSPOTS[index] ?? [])],
  };
};

const FULLY_COMPLETE = 1;

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

/**
 * Snapshot captured by `prepareAdvanceStage` and consumed by
 * `applyAdvanceStage` / `rollbackAdvanceStage`. Holding the previous
 * `currentStage` here (rather than re-reading the store inside
 * `rollback`) is what keeps BUG-FE-MAP-005 closed under racing
 * advances: each mutate has its own snapshot.
 */
export interface AdvanceStageContext {
  prev: number;
  next: number;
}

export const stageService = {
  /**
   * Fetch the stage list, map to StageData, and write it into the store. On
   * failure, leaves existing state in place and records an error message.
   */
  loadStages: async (token?: string): Promise<void> => {
    const store = useStageStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const apiStages = await stagesApi.list(token);
      // Sort descending by stage_number (10 at top, 1 at bottom) to match
      // the background artwork.
      const sorted = [...apiStages].sort((a, b) => b.stage_number - a.stage_number);
      useStageStore.getState().setStages(sorted.map(toStageData));
      useStageStore.getState().setCurrentStage(deriveCurrentStage(apiStages));
      useStageStore.getState().setLoading(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stages';
      useStageStore.getState().setError(message);
      useStageStore.getState().setLoading(false);
    }
  },

  /**
   * Build the context for an optimistic stage advance. Captures the
   * current stage from the store before any mutation so the rollback
   * closure has a snapshot it can trust regardless of concurrent
   * loads. Returns `null` when the proposed `next` equals the current
   * stage — there is nothing to advance.
   */
  prepareAdvanceStage: (next: number): AdvanceStageContext | null => {
    const prev = useStageStore.getState().currentStage;
    if (prev === next) return null;
    return { prev, next };
  },

  /** Synchronous step: bump `currentStage` to the optimistic value. */
  applyAdvanceStage: (ctx: AdvanceStageContext): void => {
    useStageStore.getState().setCurrentStage(ctx.next);
  },

  /**
   * Network step: refresh the stage list from the server so
   * `currentStage` and `stages` end up consistent. We re-derive
   * `currentStage` from the server's response rather than trusting our
   * optimistic value — the chain-validation invariant lives on the
   * backend, and the local hint may have advanced past what the server
   * permits (e.g., a missing completion).
   *
   * Implemented as a direct API call rather than `loadStages` so the
   * error propagates: `loadStages` deliberately swallows failures into
   * `useStageStore.error` (so background refreshes don't crash the
   * UI), but the optimistic-mutation rollback needs to know the
   * commit failed. We mirror loadStages's success-path side effects
   * here and let the caller's rollback restore the snapshot.
   *
   * The optional `token` mirrors `loadStages`'s signature for symmetry;
   * the API client injects auth via interceptors so neither
   * `useStageAdvance` nor `loadStages`'s call sites currently pass one.
   * Keeping the parameter on this internal-only entry point lets a
   * future caller thread an explicit token without changing the shape.
   */
  commitAdvanceStage: async (_ctx: AdvanceStageContext, token?: string): Promise<void> => {
    const store = useStageStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const apiStages = await stagesApi.list(token);
      const sorted = [...apiStages].sort((a, b) => b.stage_number - a.stage_number);
      useStageStore.getState().setStages(sorted.map(toStageData));
      useStageStore.getState().setCurrentStage(deriveCurrentStage(apiStages));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stages';
      useStageStore.getState().setError(message);
      throw err;
    } finally {
      useStageStore.getState().setLoading(false);
    }
  },

  /**
   * Failure step: restore the previous `currentStage`. Errors are
   * surfaced through `useStageStore.error` by `loadStages` itself; here
   * we just reverse the optimistic write so the map UI doesn't show a
   * stage the user hasn't actually unlocked.
   */
  rollbackAdvanceStage: (ctx: AdvanceStageContext): void => {
    useStageStore.getState().setCurrentStage(ctx.prev);
  },
};

export type StageService = typeof stageService;
