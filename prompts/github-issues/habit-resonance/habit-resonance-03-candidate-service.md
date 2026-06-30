# habit-resonance-03: Active completion-candidate gathering service

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** — (reads existing models) · **Scope:** Backend · **Est. LoC:** ~180

## Problem

Detection (issue 02) takes an opaque list of `DetectionCandidate`s. Something
must turn the caller's *current* habits and practices into that list: pick a
representative goal per habit, resolve display names, bound the count, and stamp
stable indices. This issue owns that DB-facing logic so the endpoint (issue 04)
stays thin. **Habits only here**; practices are appended by issue 08 behind the
same function (a `include_practices` flag defaulting off until 08 ships).

## Tasks — `backend/src/services/completion_candidates.py`

- `CLEAR_TIER = GoalTier.CLEAR`; `MAX_CANDIDATES = 25` (named — bounds prompt
  cost; log when truncating, like the journal search scan warning).
- `async gather_candidates(session, user_id, *, include_practices=False) ->
  list[DetectionCandidate]`:
  - Load the user's habits (with goals eager-loaded — reuse the habits router's
    eager-load pattern to avoid N+1). For each habit choose the
    **representative goal**: the `clear`-tier goal if present, else the first
    goal by id; skip a habit with no goals.
  - Build `DetectionCandidate(target_type="habit", target_id=<goal_id>,
    name=<habit.name>)`. Indices are assigned densely (`enumerate`) **after**
    the full list is built so they're stable for one detection call.
  - Truncate to `MAX_CANDIDATES` (habits first, deterministic order — e.g. by
    `sort_order` then id) and `logger.warning` the dropped count.
  - When `include_practices` is True (issue 08), append the user's **active**
    `UserPractice` rows (`end_date IS NULL`) as
    `DetectionCandidate(target_type="practice", target_id=<user_practice_id>,
    name=<custom_name or practice.name>)`. Leave a clearly-marked seam now;
    keep the habit path complete and tested.
- `async representative_goal(session, habit) -> Goal | None` helper (clear-tier
  → first-goal fallback) — reused by the accept endpoint (issue 05) so the goal
  picked for detection is the goal checked off. Export it.

## Tasks — tests (`backend/tests/test_completion_candidates.py`)

Use the existing async DB fixtures (`db_session`):

- A user with two habits (one with low/clear/stretch tiered goals, one with a
  single goal) yields two candidates; the tiered habit resolves to its **clear**
  goal id; the single-goal habit resolves to its only goal.
- A habit with **no** goals is skipped.
- `representative_goal` returns the clear goal when present, the first goal
  otherwise, `None` for a goal-less habit.
- More than `MAX_CANDIDATES` habits ⇒ truncated to the cap, deterministic order,
  warning logged.
- `include_practices=False` (default) returns **no** practice candidates even
  when the user has active practices (the 08 seam is dormant).
- Indices are dense and unique across the returned list.

## Acceptance criteria

- [ ] `gather_candidates` returns stable, de-duped, capped habit candidates with
      the clear-tier (fallback first) goal as `target_id`; goal-less habits
      skipped; truncation warned.
- [ ] `representative_goal` exported and reused-ready for issue 05.
- [ ] Practice path is a dormant, flagged seam (no behavior until 08).
- [ ] New tests pass; no N+1 (assert query strategy or eager-load); check-all green.

## Files

| File | Action |
|------|--------|
| `backend/src/services/completion_candidates.py` | New — candidate gathering + `representative_goal` |
| `backend/tests/test_completion_candidates.py` | New |

## Constraints

- Reuse the habits router's eager-load idiom for goals; do not introduce a new
  query helper layer. `GoalTier` comes from `models.goal`. Bound the candidate
  count with a named constant and log truncation — never silently drop.
