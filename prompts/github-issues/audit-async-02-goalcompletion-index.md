# audit-async-02: Add a composite index to GoalCompletion

**Labels:** `audit-async`, `backend`, `performance`, `priority-high`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~150  (hard cap 700)

## Problem
`GoalCompletion` is the highest-write table in the app yet has no index covering
its hot read filters. Every streak/stats query filters on `goal_id`/`user_id`
and sorts by `timestamp`, so each one full-scans and sorts the table
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:52`; §5.3 missing index / N+1 exposure).
**Current state:** `models/goal_completion.py:23-34` declares only the primary
key and foreign keys — no `__table_args__` index on `(goal_id, user_id,
timestamp)`.

## Scope
Covers adding one composite index `(goal_id, user_id, timestamp)` declared on the
model plus a reversible Alembic migration that creates it. Does NOT add other
indexes, change columns, or alter any query — read paths benefit automatically
from the planner picking up the index.

## Tasks
1. **Add a failing model/index test** — in `tests/models/` assert the
   `GoalCompletion` table metadata contains a composite index over
   `("goal_id", "user_id", "timestamp")` (inspect
   `GoalCompletion.__table__.indexes`). Write it first; watch it fail.
2. **Declare the index on the model** — add `__table_args__` with an
   `Index("ix_goalcompletion_goal_user_ts", "goal_id", "user_id", "timestamp")`
   to `models/goal_completion.py:23-34`, following the comment+declaration
   convention already used in `models/journal_entry.py:52-55` so `alembic check`
   sees model and migration agree.
3. **Generate a reversible migration** — add an Alembic revision whose `upgrade()`
   calls `op.create_index(...)` and whose `downgrade()` calls
   `op.drop_index(...)`. No destructive operation; the migration must be fully
   reversible.
4. **Confirm conftest index mirror** — ensure the SQLite test mirror in
   `conftest.py` reflects the new index if it maintains an explicit list (see
   `2026-06-24_ADEPTHOOD_FULL_AUDIT.md:158`).

## Acceptance Criteria
- [ ] `GoalCompletion.__table__.indexes` contains a composite index over
      `(goal_id, user_id, timestamp)`.
- [ ] The Alembic migration `upgrade()` creates and `downgrade()` drops the
      index; `alembic upgrade head` then `alembic downgrade -1` round-trips
      cleanly with no destructive op.
- [ ] `alembic check` reports no model/migration drift.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/models/goal_completion.py` | Modify |
| `backend/migrations/versions/<rev>_add_goalcompletion_composite_index.py` | Create |
| `backend/tests/models/test_goal_completion_index.py` | Create |
