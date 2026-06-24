# audit-render-04: Dedup the stats fetch on stats modal open

**Labels:** `audit-render`, `frontend`, `performance`, `priority-high`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~150  (hard cap 700)

## Problem

Opening the Habits stats modal fires `habitsApi.getStats(id)` **twice**. Current
state (§5.2 render cost, severity **High**): both the `useHabitStats` hook and a
`useEffect` inside `frontend/src/features/Habits/StatsModal.tsx:251-274` fetch
stats for the same habit when the modal opens, doubling network traffic, doubling
load latency, and risking a race between the two in-flight responses. The fetch
should happen exactly once.

## Scope

Covers lifting stats loading to a single source of truth — either the
`useHabitStats` hook OR the modal effect, not both — so one open triggers one
`getStats(id)` call. Does NOT change what stats are displayed, the loading/empty
states, or any visual output — only the number of fetches.

## Tasks

1. **Locate both fetch sites** — confirm the duplication: `useHabitStats` (the
   hook) and the `useEffect` in `StatsModal.tsx:251-274`. Decide the single
   owner (prefer the hook, which already exists for this purpose, and have the
   modal consume its result via props/context).
2. **Remove the redundant fetch** — delete the second fetch path so only one
   `getStats(id)` call fires per modal open; pass data/loading/error from the
   single owner into `StatsModal`.
3. **Guard against re-fetch churn** — ensure the remaining effect's dependency
   list does not refire on unrelated re-renders (stabilize id/owner refs).
4. **Call-count test** — in `frontend/src/features/Habits/__tests__/`, add a
   `@testing-library/react-native` test that mocks `habitsApi.getStats`, opens the
   stats modal for one habit, and asserts `getStats` was called exactly once with
   that habit id.

## Acceptance Criteria

- [ ] Opening the stats modal fires `habitsApi.getStats(id)` exactly once,
      proven by the mocked call-count test.
- [ ] Displayed stats, loading, and error states are unchanged.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/StatsModal.tsx` | Modify (remove duplicate effect fetch; consume hook data) |
| `frontend/src/features/Habits/hooks/useHabitStats.ts` | Modify (own the single fetch) |
| `frontend/src/features/Habits/__tests__/StatsModal.fetch-dedup.test.tsx` | Create (call-count test) |
