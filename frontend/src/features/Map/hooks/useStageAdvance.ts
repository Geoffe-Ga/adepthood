/**
 * `useStageAdvance` — call site that wires `stageService` into
 * `useOptimisticMutation` so a stage advance feels instant in the UI
 * but safely rolls back when the server-side reload rejects the new
 * stage (BUG-FE-MAP-005).
 *
 * Apply bumps `currentStage` synchronously; commit re-fetches the
 * stage list (the chain-validation invariant lives on the backend, so
 * the server's response is canonical); rollback restores the previous
 * `currentStage`.
 */
import { useCallback } from 'react';

import { useOptimisticMutation } from '../../../hooks/useOptimisticMutation';
import { stageService, type AdvanceStageContext } from '../services/stageService';

export interface UseStageAdvanceResult {
  /** Advance to `next`. Resolves once the server reload settles. */
  advanceStage: (_next: number) => Promise<void>;
  /** True while `commit` (the loadStages refresh) is in flight. */
  pending: boolean;
}

export function useStageAdvance(): UseStageAdvanceResult {
  const mutation = useOptimisticMutation<AdvanceStageContext, void>({
    apply: (ctx) => stageService.applyAdvanceStage(ctx),
    commit: (ctx) => stageService.commitAdvanceStage(ctx),
    rollback: (ctx) => stageService.rollbackAdvanceStage(ctx),
  });

  const advanceStage = useCallback(
    async (next: number): Promise<void> => {
      const ctx = stageService.prepareAdvanceStage(next);
      if (!ctx) return;
      try {
        await mutation.mutate(ctx);
      } catch {
        // Already rolled back; the error is recorded on
        // `useStageStore.error` by `loadStages` so a subscribed UI can
        // surface a retry affordance.
      }
    },
    [mutation],
  );

  return { advanceStage, pending: mutation.pending };
}
