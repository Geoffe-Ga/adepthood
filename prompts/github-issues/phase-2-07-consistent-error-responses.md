# phase-2-07: Fix inconsistent backend error response patterns

**Labels:** `phase-2`, `backend`, `cleanup`, `priority-medium`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~100–150

## Problem

Error responses across backend routers use inconsistent patterns for status codes, detail messages, and argument style:

**Positional vs keyword arguments:**
```python
# routers/auth.py — positional
raise HTTPException(status.HTTP_400_BAD_REQUEST, "user exists")

# routers/goal_completions.py — keyword
raise HTTPException(status_code=404, detail="goal_not_found")

# routers/practice.py — positional with magic number
raise HTTPException(403, "cannot create for another user")
```

**Magic numbers vs constants:**
- `auth.py` uses `status.HTTP_401_UNAUTHORIZED` (correct)
- `practice.py` uses `403` (magic number)
- `habits.py` uses `404` (magic number)

**Detail message format:**
- `"user exists"` — lowercase, human-readable
- `"goal_not_found"` — snake_case, machine-readable
- `"cannot create for another user"` — lowercase sentence
- `"Habit not found"` — title case
- `"missing token"`, `"invalid token"`, `"expired token"` — lowercase, terse

**Domain exceptions not caught:**
- `domain/energy.py` raises `ValueError("habits must not be empty")`
- `domain/goals.py` raises `ValueError("target must be positive")`
- Neither is caught by the calling router — they bubble up as 500 Internal Server Error

**DELETE returns 200 with None body:**
- `routers/habits.py:52-58` returns `None` from a DELETE endpoint
- HTTP convention: DELETE should return 204 No Content

## Scope

Standardize all error responses and add domain exception handling.

## Tasks

1. **Create a consistent error format**
   - Always use keyword arguments: `raise HTTPException(status_code=..., detail=...)`
   - Always use `status` constants: `status.HTTP_404_NOT_FOUND`, not `404`
   - Detail messages should be machine-readable snake_case: `"habit_not_found"`, `"user_already_exists"`, `"unauthorized"`
   - If human-readable messages are needed, add a `message` field to the response body

2. **Create `backend/src/errors.py` helper**
   ```python
   from fastapi import HTTPException, status

   def not_found(resource: str) -> HTTPException:
       return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource}_not_found")

   def forbidden(reason: str = "forbidden") -> HTTPException:
       return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=reason)

   def bad_request(reason: str) -> HTTPException:
       return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=reason)
   ```

3. **Add domain exception handler middleware or try/except blocks**
   - Catch `ValueError` from domain functions and convert to 400 Bad Request
   - Option A: try/except in each router endpoint
   - Option B: FastAPI exception handler: `@app.exception_handler(ValueError)`

4. **Fix DELETE response code**
   - `routers/habits.py`: Add `status_code=204` to the decorator: `@router.delete("/{habit_id}", status_code=204)`
   - Update `test_habits_api.py` to expect 204 instead of 200

5. **Update all routers**
   - `routers/auth.py` — use helper functions
   - `routers/habits.py` — use helper functions, add auth check
   - `routers/practice.py` — replace `403` with `status.HTTP_403_FORBIDDEN`
   - `routers/goal_completions.py` — use helper functions, catch ValueError
   - `routers/energy.py` — catch ValueError from `generate_plan()`

6. **Update all tests** — assert on the standardized detail strings

## Acceptance Criteria

- All error responses use keyword arguments and status constants
- All detail messages are snake_case and consistent
- Domain `ValueError` exceptions return 400 not 500
- DELETE endpoints return 204
- All tests updated and passing

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/errors.py` | **Create** |
| `backend/src/routers/auth.py` | Modify |
| `backend/src/routers/habits.py` | Modify |
| `backend/src/routers/practice.py` | Modify |
| `backend/src/routers/goal_completions.py` | Modify |
| `backend/src/routers/energy.py` | Modify |
| `backend/src/main.py` | Modify (optional: add ValueError handler) |
| `backend/tests/test_habits_api.py` | Modify (expect 204 for DELETE) |
| `backend/tests/test_goal_completions.py` | Modify |
