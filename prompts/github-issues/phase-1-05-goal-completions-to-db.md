# phase-1-05: Migrate goal_completions router from in-memory dict to database queries

**Labels:** `phase-1`, `backend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-01, phase-1-02
**Estimated LoC:** ~150–200

## Problem

`backend/src/routers/goal_completions.py` uses a hardcoded in-memory dict with a single demo goal:

```python
_goal_state: dict[int, GoalState] = {1: GoalState(streak=0, thresholds=[1, 3])}
```

Only goal ID 1 exists. Any other goal ID returns 404. The `GoalState` dataclass stores `streak` and `thresholds` but these are never persisted. The router correctly uses domain functions (`update_streak`, `achieved_milestones`) which is good architecture — but the data layer beneath them is a toy.

Additionally, domain function errors (`ValueError` from `domain/goals.py`) are not caught by the router — they would bubble up as 500 Internal Server Error instead of 400 Bad Request.

## Scope

Replace the hardcoded dict with DB queries against the existing `GoalCompletion` and `Goal` SQLModels. Add proper error handling for domain exceptions.

## Tasks

1. **Replace `_goal_state` with DB queries**
   - Query `Goal` model to get thresholds and current streak
   - Store completions in `GoalCompletion` model (already defined in `models/goal_completion.py`)
   - Remove `GoalState` dataclass and `_goal_state` dict

2. **Add authentication**
   - Goals belong to habits, habits belong to users — ensure the requesting user owns the goal
   - Add `Depends(get_current_user)` to the endpoint

3. **Catch domain exceptions**
   - Wrap `update_streak()` and `achieved_milestones()` calls in try/except
   - Convert `ValueError` to `HTTPException(400, detail=str(e))`

4. **Update tests**
   - `tests/test_goal_completions.py` currently resets `_goal_state[1].streak = 0` — replace with DB seeding
   - Add test: domain ValueError returns 400
   - Add test: goal belonging to different user returns 403

## Acceptance Criteria

- Goal completions persist in DB
- Domain errors return 400 not 500
- User can only complete their own goals
- All goal completion tests pass

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/goal_completions.py` | Rewrite |
| `backend/tests/test_goal_completions.py` | Rewrite |
