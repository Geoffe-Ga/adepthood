# audit-contracts-01: Restore `days_of_week` in `goalSchema`

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-critical`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~120  (hard cap 700)

## Problem

`goalSchema` in `frontend/src/api/schemas.ts:153-166` does not declare
`days_of_week`. Zod object schemas strip unknown keys by default, so the field
is **deleted from every validated `habits.list` / `habits.get` response** even
though the backend sends it (`backend/src/schemas/goal.py:42`,
`days_of_week: list[str] | None = None`) and the frontend already types it on
`ApiGoal` (`frontend/src/api/index.ts:769-770`). The weekly cadence is consumed
downstream at `frontend/src/features/Habits/services/habitManager.ts:121`
(`days_of_week: g.days_of_week ?? undefined`), which now always reads
`undefined` after a fresh fetch. **Current state:** a weekly-cadence goal
("Mon/Wed") loses its schedule on every refetch — §5.4 class: schema drift
causing live data loss (the worst-severity row in audit §7).

## Scope

Covers: adding `days_of_week` to `goalSchema` so it survives validation, and a
regression test proving the value reaches `toLocalHabit` / `habitManager`.

Does NOT cover: the other validator gaps (issues 02-07), changing the backend
schema, or the `days_of_week` *normalisation* logic (already correct on the
backend in `GoalUpdate._validate_days_of_week`).

## Tasks

1. **Add `days_of_week` to `goalSchema`** — in
   `frontend/src/api/schemas.ts:153-166`, add
   `days_of_week: z.array(z.string()).nullish()`. Matches the backend's
   `list[str] | None` and the `ApiGoal` `string[] | null | undefined` shape.
   `.nullish()` accepts `null`, `undefined`, and absent (older API builds).
2. **Verify the type flows through** — confirm `GoalSchemaT`
   (`schemas.ts:202`) now includes `days_of_week` and that `toLocalHabit`
   (`index.ts:872`) and `habitManager.ts:121` compile against it without a
   cast. No change needed if the `ApiGoal` interface already carries it (it
   does) — but assert it in a test rather than by inspection.
3. **Add a Zod regression test** — in
   `frontend/src/api/__tests__/` (alongside `retryAndValidation.test.ts` /
   `toLocalHabit.test.ts`), parse a goal payload containing
   `days_of_week: ['Mon', 'Wed']` through `goalSchema` (or
   `habitWithGoalsSchema`) and assert the array survives — proving strip-mode
   no longer deletes it.

## Acceptance Criteria

- [ ] `days_of_week: ['Mon', 'Wed']` survives `goalSchema` validation, proven
      by a `schemas.test.ts` (or `retryAndValidation.test.ts`) case that parses
      and asserts the array is preserved.
- [ ] A `habitWithGoalsSchema` parse of a habit whose goal carries
      `days_of_week` reaches `toLocalHabit` with the value intact (assert via
      the existing `toLocalHabit` test fixture).
- [ ] `null`, `undefined`, and absent `days_of_week` all parse without error
      (back-compat with older API builds).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/schemas.ts` | Modify — add `days_of_week` to `goalSchema` |
| `frontend/src/api/__tests__/schemas.test.ts` | Create or modify — add survival test |
| `frontend/src/api/__tests__/toLocalHabit.test.ts` | Modify — assert `days_of_week` reaches local mapping |
</content>
