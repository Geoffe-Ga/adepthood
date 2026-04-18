# Prompt 08 — `useOptimisticMutation` hook + standardized rollback (Wave 3, parallelizable)

## Role
You are a React Native engineer who has watched too many optimistic-update bugs ship. You want a single, well-tested hook that owns: optimistic apply → commit on success → rollback on error → retry queue integration.

## Goal
Replace ad-hoc optimistic patterns across Habits, Journal, Practice, and Map with a single `useOptimisticMutation` hook. Fix the five bugs in the "optimistic writes that don't roll back" family as a side effect of adopting the hook.

Success criteria:

1. `frontend/src/hooks/useOptimisticMutation.ts` exports a hook that accepts `{ apply, commit, rollback, queue? }` and guarantees the disk + queue state always matches the store state after rollback.
2. `HabitLogUnit`, `JournalSendMessage`, `PracticeWeeklyCount`, `MapStageAdvance`, and `OfflineCheckIn` call sites migrate to the hook.
3. `savePendingCheckIn` read-modify-write race is closed with a serialized write lane (in-memory promise chain per key).
4. Every mutation has a test that simulates the server error: store reverts, persisted storage reverts, UI shows a retryable error toast.
5. `Date.now()` as a message ID is replaced by `crypto.randomUUID()` (or `expo-crypto`'s equivalent) to prevent retry collisions.

## Context
- `prompts/2026-04-18-bug-remediation/16-frontend-features-habits-journal.md` — **BUG-FE-HABIT-001** (Critical; optimistic logUnit rollback gap), **BUG-FE-HABIT-205** (Critical; logUnit replay drops `timestamp`), **BUG-FE-JOURNAL-002** (orphaned optimistic user message on stream error), **BUG-FE-JOURNAL-003** (`Date.now()` id collision on retry).
- `prompts/2026-04-18-bug-remediation/17-frontend-features-practice-course-map.md` — **BUG-FE-PRACTICE-005** (weekly count not rolled back — read full block to confirm ID, may be under a different sub-ID in the report), **BUG-FE-MAP-005** (no retry/rollback on stage advance failure).
- `prompts/2026-04-18-bug-remediation/18-frontend-design-state-tests.md` — **BUG-FE-STORAGE-002** (`savePendingCheckIn` read-modify-write race).

Files you will touch (expect ≤12): new `frontend/src/hooks/useOptimisticMutation.ts` + test, new `frontend/src/storage/serializedWrite.ts`, `frontend/src/features/Habits/**`, `frontend/src/features/Journal/**`, `frontend/src/features/Practice/**`, `frontend/src/features/Map/**`, `frontend/src/storage/habitStorage.ts`.

## Output Format
Five atomic commits:

1. `feat(frontend): add useOptimisticMutation hook + serialized write lane`.
2. `fix(frontend): migrate habit logUnit to useOptimisticMutation (BUG-FE-HABIT-001, -205)`.
3. `fix(frontend): migrate journal send + replace Date.now() ids (BUG-FE-JOURNAL-002, -003)`.
4. `fix(frontend): migrate practice weekly count + map stage advance (BUG-FE-PRACTICE-005, BUG-FE-MAP-005)`.
5. `fix(frontend): serialize savePendingCheckIn writes (BUG-FE-STORAGE-002)`.

## Examples

Hook contract:
```ts
// frontend/src/hooks/useOptimisticMutation.ts
type Config<TInput, TResult> = {
  apply: (input: TInput) => void;        // synchronous store update
  commit: (input: TInput) => Promise<TResult>; // network call
  rollback: (input: TInput, err: Error) => void;
  onSuccess?: (input: TInput, result: TResult) => void;
};

export function useOptimisticMutation<TInput, TResult>(cfg: Config<TInput, TResult>) {
  // Stash cfg in a ref so we don't re-create `mutate` every render.
  // If we depended on [cfg] and callers passed an object literal, `mutate`
  // would change identity every render and any downstream effect/memo
  // keyed on it would thrash (infinite re-render chains are easy to hit).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [pending, setPending] = useState(false);
  const mutate = useCallback(async (input: TInput) => {
    const c = cfgRef.current;
    c.apply(input);
    setPending(true);
    try {
      const result = await c.commit(input);
      c.onSuccess?.(input, result);
      return result;
    } catch (err) {
      c.rollback(input, err as Error);
      throw err;
    } finally {
      setPending(false);
    }
  }, []);  // stable identity for the lifetime of the hook
  return { mutate, pending };
}
```
**Do NOT** write `useCallback(..., [cfg])` — call sites like
`useOptimisticMutation({ apply, commit, rollback })` create a fresh `cfg`
every render. The ref+stable-callback pattern above is deliberate.

Serialized write lane:
```ts
// frontend/src/storage/serializedWrite.ts
const chains = new Map<string, Promise<unknown>>();
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // `then(fn, fn)` is intentional: `fn` runs whether `prev` resolved OR rejected.
  // A prior write's failure must NOT block the next write in the lane — but
  // `fn`'s own rejection (the thing THIS caller wants to know about) still
  // propagates to `next`, so the returned promise rejects for the caller
  // that owns the failing write.
  const next = prev.then(fn, fn);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}
```

## Requirements
- `testing`: rollback tests must assert BOTH store state AND persisted storage state revert — not just store.
- No `any` types in the hook generics.
- `max-quality-no-shortcuts`: do not swallow errors in the hook — re-throw after rollback so call sites can surface retry UX.
- If the migration for a specific call site is risky (e.g., touches a complex reducer), stop, document in the BUG-ID block, and move on — do not force it.
- For `savePendingCheckIn`, use the same `serialize()` helper; do not introduce a separate queue just for this one call.
- `pre-commit run --all-files` before each commit.
- Parallelizable with 04-07, 09-10. Merges cleanly with Prompt 14 (frontend feature screens) — Prompt 08 lands first.
