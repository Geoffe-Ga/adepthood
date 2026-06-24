# audit-async-04: Batch the per-stage progress N+1 in list_stages

**Labels:** `audit-async`, `backend`, `performance`, `priority-high`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~300  (hard cap 700)

## Problem
`list_stages` calls `compute_stage_progress` once per stage inside a Python loop,
so each request issues N stages × M metric queries. This grows to 36 stages on
the primary course surface, making the most-visited screen's query count scale
linearly with course length (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:54`; §5.3 N+1).
**Current state:** `routers/stages.py:76-102` iterates stages and computes
progress per stage individually.

## Scope
Covers replacing the per-stage loop with grouped/aggregated queries so the
endpoint issues ≤3 queries regardless of stage count, preserving the exact
per-stage progress values returned today. Does NOT change the response schema,
pagination behavior, or the definition of "progress" for a stage.

## Tasks
1. **Add a failing query-count test** — in `tests/routers/`, seed a user with
   several stages and completions, count DB round-trips for `GET` list_stages
   (e.g. via a SQLAlchemy `before_cursor_execute` event listener or an
   engine/session execute counter), and assert `<= 3`. Write it first; watch it
   fail against the current loop.
2. **Add a batched progress function** — introduce a
   `compute_stage_progress_batch(...)` (in `domain/`/alongside the existing
   `compute_stage_progress`) that fetches the metric rows for all requested
   stages in grouped queries (`GROUP BY` stage) and returns a per-stage mapping.
3. **Rewire the router** — replace the loop at `routers/stages.py:76-102` to call
   the batch function once and assemble responses from its mapping.
4. **Parity test** — assert the batched results equal the old per-stage results
   for a multi-stage fixture (same numbers, same ordering) so behavior is
   provably unchanged.

## Acceptance Criteria
- [ ] `GET` list_stages issues ≤3 DB queries regardless of stage count
      (asserted by the query-count test).
- [ ] Per-stage progress values are identical to the pre-change loop output for
      the parity fixture.
- [ ] Response schema, ordering, and pagination are unchanged.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/stages.py` | Modify |
| `backend/src/domain/stage_progress.py` | Modify |
| `backend/tests/routers/test_stages_query_count.py` | Create |
