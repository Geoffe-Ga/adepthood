/**
 * `useSaveSessionMutation` — the one apply → POST → commit / rollback pipe for
 * writing a practice session.
 *
 * Extracted from `ActiveRitualSession` when the manual-log sheet became a
 * second writer of `POST /practice-sessions/`: both paths need the same
 * optimistic week-count increment, the same rollback on failure, and the same
 * "turn the error into something a person can act on" step. The only thing
 * that differs is the copy, which is why `errorOptions` is a parameter rather
 * than a constant — the timer talks about timer minutes, the manual form talks
 * about the window it refused.
 */
import type { PracticeSessionCreate, PracticeSessionResponse } from '@/api';
import { practiceSessions } from '@/api';
import type { FormatErrorOptions } from '@/api/errorMessages';
import { formatApiError } from '@/api/errorMessages';
import type { OptimisticMutation } from '@/hooks/useOptimisticMutation';
import { useOptimisticMutation } from '@/hooks/useOptimisticMutation';

export interface UseSaveSessionMutationParams {
  /** Optimistic +1 on the weekly bar, run before the request. */
  apply: () => void;
  /** Reverse `apply` when the request fails. */
  rollback: () => void;
  /** Authoritative refetch once the server confirms the row. */
  commit: () => void;
  /** Surface (or clear) the failure copy for the caller's own banner. */
  setSaveError: (_msg: string | null) => void;
  /** Caller copy for failures: its fallback and any per-status override. */
  errorOptions: FormatErrorOptions;
}

/**
 * Wire the session write to the caller's optimistic callbacks.
 *
 * @param params - The optimistic callbacks, error sink, and failure copy.
 * @returns The `mutate`/`pending` pair from `useOptimisticMutation`.
 */
export function useSaveSessionMutation({
  apply,
  rollback,
  commit,
  setSaveError,
  errorOptions,
}: UseSaveSessionMutationParams): OptimisticMutation<
  PracticeSessionCreate,
  PracticeSessionResponse
> {
  return useOptimisticMutation<PracticeSessionCreate, PracticeSessionResponse>({
    apply: () => {
      setSaveError(null);
      apply();
    },
    commit: async (payload) => {
      const session = await practiceSessions.create(payload);
      commit();
      return session;
    },
    rollback: (_input, err) => {
      rollback();
      setSaveError(formatApiError(err, errorOptions));
    },
  });
}
