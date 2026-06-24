# audit-async-05: Remove the seeding write from the list_goal_groups GET path

**Labels:** `audit-async`, `backend`, `correctness`, `priority-medium`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~200  (hard cap 700)

## Problem
`list_goal_groups` calls `ensure_seed_templates` — a SELECT plus a conditional
INSERT plus a commit — on every GET. A read endpoint that writes violates HTTP
semantics, adds an extra round-trip to a hot read, and risks write contention;
botmason already fixed this exact anti-pattern for `/user/usage`
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:56`; §5.3 GET that writes).
**Current state:** `routers/goal_groups.py:48-61` invokes `ensure_seed_templates`
inside the `list_goal_groups` GET handler.

## Scope
Covers moving template seeding out of the GET read path so `list_goal_groups`
performs no INSERT/commit, while preserving that seed templates still exist when a
user needs them. Does NOT change the goal-group response schema or remove the
seeding logic itself — only when/where it runs.

## Tasks
1. **Add a failing no-write test** — in `tests/routers/`, install a
   commit/flush spy (or count INSERT statements via a SQLAlchemy event listener)
   and assert that a `GET` to list_goal_groups performs zero INSERTs/commits.
   Write it first; watch it fail against the current handler.
2. **Relocate seeding** — move `ensure_seed_templates` to a write-time trigger:
   either an idempotent call on goal-group/goal *creation*, an app-startup/
   migration-time seed, or an explicit seed endpoint — whichever matches the
   existing botmason `/user/usage` fix pattern referenced in the audit. Keep the
   call idempotent.
3. **Strip the call from the GET** — remove `ensure_seed_templates` from
   `routers/goal_groups.py:48-61`.
4. **Preserve availability test** — add/extend a test proving seed templates are
   present after the new trigger fires (e.g. after first create, or after
   startup seed), so users still get defaults.

## Acceptance Criteria
- [ ] `GET` list_goal_groups performs no INSERT and no commit (asserted by the
      no-write test).
- [ ] Seed templates are still available to users via the relocated trigger
      (asserted by the availability test).
- [ ] Goal-group response schema is unchanged.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/goal_groups.py` | Modify |
| `backend/tests/routers/test_goal_groups_no_write_on_get.py` | Create |
