# phase-1-02: Migrate habits router from in-memory list to database queries

**Labels:** `phase-1`, `backend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-01
**Estimated LoC:** ~200–250

## Problem

`backend/src/routers/habits.py` stores all habits in a module-level Python list:

```python
_habits: list[Habit] = []
_id_counter = count(1)
```

Every CRUD operation (create, list, get, update, delete) mutates this list. Data is lost on restart, not thread-safe under concurrent requests, and impossible to scale across multiple server instances.

Additionally, the habits router has **no authentication** — anyone can create/read/update/delete any user's habits. Compare with `routers/practice.py` which correctly checks `payload.user_id != current_user`.

## Scope

Replace all in-memory operations with SQLModel database queries via the session from `phase-1-01`. Add user-scoping so users only see their own habits.

## Tasks

1. **Replace in-memory store with DB queries**
   - Remove `_habits: list[Habit]` and `_id_counter` module-level state
   - Inject `session: AsyncSession = Depends(get_session)` into each endpoint
   - `create_habit`: `session.add(habit)` + `await session.commit()`
   - `list_habits`: `session.exec(select(Habit).where(Habit.user_id == current_user).order_by(Habit.sort_order))`
   - `get_habit`: `session.get(Habit, habit_id)` with 404 if not found or wrong user
   - `update_habit`: Fetch, update fields, commit
   - `delete_habit`: Fetch, delete, commit. Return 204 No Content (currently returns 200 with None body, which is non-standard)

2. **Add authentication dependency**
   - Import `get_current_user` from `routers/auth.py`
   - Add `current_user: int = Depends(get_current_user)` to all endpoints
   - Filter all queries by `user_id == current_user` — a user must never see another user's habits

3. **Make endpoints async**
   - Change `def create_habit(...)` to `async def create_habit(...)` for all endpoints
   - Required because database operations are async

4. **Update schema if needed**
   - `schemas/habit.py` `HabitCreate` already has `user_id` — consider whether the API should accept `user_id` in the body (insecure — user could fake it) or derive it from the auth token. Recommendation: remove `user_id` from `HabitCreate` and set it server-side from `current_user`

5. **Update tests**
   - `tests/test_habits_api.py` currently resets `_habits.clear()` in fixtures — replace with DB transaction rollback
   - Add test: authenticated user can only see their own habits
   - Add test: unauthenticated request returns 401

## Acceptance Criteria

- Habits persist across server restarts
- Each user only sees their own habits
- Unauthenticated requests return 401
- All existing habit CRUD tests pass (adapted for DB)
- DELETE returns 204 No Content

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/habits.py` | Rewrite (DB queries, auth, async) |
| `backend/src/schemas/habit.py` | Modify (remove user_id from HabitCreate) |
| `backend/tests/test_habits_api.py` | Rewrite (DB fixtures, auth tests) |
