/**
 * `useOptimisticMutation` — single, well-tested primitive for the
 * apply → commit → rollback cycle that ships across Habits, Journal,
 * Practice, and Map.
 *
 * Closes the "optimistic writes that don't roll back" family of bugs
 * (BUG-FE-HABIT-001, -205; BUG-FE-JOURNAL-002, -003; BUG-FE-PRACTICE-005;
 * BUG-FE-MAP-005) by giving every call site one place where rollback is
 * guaranteed and persisted state is kept in lockstep with the in-memory
 * store.
 *
 * Contract:
 *   - `apply(input)` must be synchronous and idempotent. It is the only
 *     path that mutates the store before the network call completes.
 *   - `commit(input)` performs the network round-trip and returns the
 *     server's authoritative response.
 *   - `rollback(input, err)` must reverse `apply` *and* any disk write
 *     `apply` triggered. It runs after `commit` rejects and BEFORE the
 *     hook re-throws, so call sites can rely on the rolled-back state
 *     when they catch the error themselves.
 *   - `onSuccess` runs only after `commit` resolves. Side effects that
 *     must not fire on failure (milestone toasts, navigation) belong
 *     here, not in `apply`.
 */
import { useCallback, useRef, useState } from 'react';

export interface OptimisticMutationConfig<TInput, TResult> {
  /** Synchronous store + disk update. Must be self-contained. */
  apply: (_input: TInput) => void;
  /** Network call. Returns the server's authoritative response. */
  commit: (_input: TInput) => Promise<TResult>;
  /** Reverse `apply` (store + disk) on failure. */
  rollback: (_input: TInput, _err: Error) => void;
  /** Optional post-success hook for toasts, navigation, etc. */
  onSuccess?: (_input: TInput, _result: TResult) => void;
}

export interface OptimisticMutation<TInput, TResult> {
  /** Run apply → commit → rollback. Re-throws on failure after rolling back. */
  mutate: (_input: TInput) => Promise<TResult>;
  /** True while a `commit` is in flight. */
  pending: boolean;
}

/**
 * Stash the config in a ref so `mutate` keeps a stable identity for the
 * lifetime of the hook. If we depended on `[cfg]` and callers passed an
 * object literal (the typical pattern), `mutate` would change identity
 * every render and any downstream effect/memo keyed on it would thrash —
 * infinite re-render chains are easy to hit.
 */
export function useOptimisticMutation<TInput, TResult>(
  cfg: OptimisticMutationConfig<TInput, TResult>,
): OptimisticMutation<TInput, TResult> {
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [pending, setPending] = useState(false);

  const mutate = useCallback(async (input: TInput): Promise<TResult> => {
    const c = cfgRef.current;
    c.apply(input);
    setPending(true);
    try {
      const result = await c.commit(input);
      c.onSuccess?.(input, result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      c.rollback(input, error);
      // Re-throw so callers can surface a retryable error — see
      // `max-quality-no-shortcuts`: the hook never swallows failures.
      throw err;
    } finally {
      setPending(false);
    }
  }, []);

  return { mutate, pending };
}
