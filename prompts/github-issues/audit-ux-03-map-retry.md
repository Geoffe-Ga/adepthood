# audit-ux-03: Add retry to Map and distinguish fetch error from empty history

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-high`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~220  (hard cap 700)

## Problem

The Map screen masks failures in two places. First, `MapScreen.tsx:482` only renders `MapError` when `error && stages.length === 0`; once any stages are cached, a failed refresh is swallowed — the user keeps seeing stale data with no signal that the refresh failed and no way to retry. Second, `StageHistorySection` (`Map/MapScreen.tsx:304-320`) calls `stagesApi.history(...).catch(() => setHistory(null))`, and `HistoryBody` renders the "Begin this stage to start tracking your journey" empty state (`:290-294`) whenever `history === null` — so a network/server **failure** is indistinguishable from a genuinely empty history. Current state: this is a **UX correctness** defect (error masquerades as empty / silent stale data); the user cannot tell "broken" from "empty" and has no retry (audit §8 `Map/MapScreen.tsx:482,304-320`, §2.8).

## Scope

**Covers:** (a) Surfacing a non-blocking retry affordance when a refresh fails while stages are already present, and (b) tracking an explicit error state in `StageHistorySection` so a fetch failure renders an error+retry message distinct from the empty state.

**Does NOT:** Change the cold-start `MapError` path (`stages.length === 0`), alter stage-unlock logic, the map background rendering, or navigation. No backend changes.

## Tasks

1. **Surface refresh failures with retry** — In `MapScreen`, when `error` is set but `stages.length > 0`, render a dismissible/retryable banner over the map (reuse the Journal-style retry pattern) instead of swallowing it. Wire its retry to the existing refresh action. TDD: with stages present, set the refresh to reject; assert a retry control (`getByLabelText`/`getByText('Try again')`) appears and pressing it re-invokes the loader.
2. **Track history error state** — In `StageHistorySection` (`:304-320`), add an `error` state set in the `.catch` (instead of only `setHistory(null)`), so empty (`history` resolved but no entries) and failed (rejected) are separable. TDD: when `stagesApi.history` rejects, the section shows an error message + retry, not the "begin this stage" copy.
3. **Render distinct history states** — Update `HistoryBody` (`:290`) so it shows: loading → spinner; error → error+retry; resolved-empty → the existing "Begin this stage..." copy; resolved-nonempty → `HistoryContent`. The retry re-runs the history fetch. TDD: each of the four branches renders its distinct, asserted output.
4. **Error copy review** — Apply the `user-facing-error-messages` rubric to both new messages (what failed / why / how to retry); no `error.message`, stack, or status code leaks into the copy.

## Acceptance Criteria

- [ ] A failed refresh with stages already present shows a retry affordance; pressing it re-invokes the loader.
- [ ] A failed history fetch renders an error+retry message that is textually distinct from the "begin this stage" empty state.
- [ ] A genuinely empty history still shows the "begin this stage" copy.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Modify (refresh retry + history error state) |
| `frontend/src/features/Map/__tests__/MapRetry.test.tsx` | **Create** |
