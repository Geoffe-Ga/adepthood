# audit-async-06: Compute compute_consecutive_streak once per check-in

**Labels:** `audit-async`, `backend`, `performance`, `priority-medium`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~180  (hard cap 700)

## Problem
A single goal check-in runs `compute_consecutive_streak` up to three times — once
on the idempotent path, once to capture `old_streak`, and once on the persist
path — each a full streak recomputation against the completion history
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:55`; §5.3 redundant queries).
**Current state:** `routers/goal_completions.py:303-335` calls
`compute_consecutive_streak` in multiple branches of the same request.

## Scope
Covers computing the consecutive streak at most once per check-in and threading
the resulting value through the idempotent, old-streak, and persist branches.
Does NOT change the streak algorithm, the persisted values, or the response
contract — only the number of times the value is computed.

## Tasks
1. **Add a failing call-count test** — in `tests/routers/`, patch/spy
   `compute_consecutive_streak` and assert it is invoked at most once per
   check-in request. Write it first; watch it fail against the current handler.
2. **Hoist the computation** — compute the streak once near the top of the
   relevant block in `routers/goal_completions.py:303-335` and pass the value
   into the idempotent, `old_streak`, and persist branches instead of
   recomputing.
3. **Value-parity test** — assert the persisted streak and the response's streak
   field equal the pre-change values for a representative check-in fixture, so
   behavior is provably unchanged.

## Acceptance Criteria
- [ ] `compute_consecutive_streak` is invoked at most once per check-in
      (asserted by the call-count test).
- [ ] Persisted streak and response streak values are identical to the
      pre-change output for the parity fixture.
- [ ] Response contract is unchanged.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/goal_completions.py` | Modify |
| `backend/tests/routers/test_goal_completions_streak_dedup.py` | Create |
