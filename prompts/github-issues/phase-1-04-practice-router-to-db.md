# phase-1-04: Migrate practice router from in-memory list to database queries

**Labels:** `phase-1`, `backend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-01, phase-1-03
**Estimated LoC:** ~150–200

## Problem

`backend/src/routers/practice.py` stores sessions in a module-level list:

```python
_sessions: list[PracticeSession] = []
_id_counter = count(1)
```

Additionally, `PracticeSession` is defined **twice** — once as a Pydantic model inline in the router file (lines 12-21) and once as a SQLModel in `models/practice_session.py`. These two definitions will diverge over time.

The `week_count` endpoint calculates the start of the week without accounting for user timezone — it uses server UTC time, which means a user in US Pacific could see Monday's session counted in the wrong week.

## Scope

Replace in-memory store with DB queries using the existing `PracticeSession` SQLModel. Remove the duplicate Pydantic definition.

## Tasks

1. **Remove duplicate `PracticeSession` Pydantic model from router**
   - Delete the inline `PracticeSession` and `PracticeSessionCreate` classes (lines 12-31)
   - Create proper schemas in `schemas/practice.py` (new file) for API request/response
   - Import the SQLModel `PracticeSession` from `models/` for DB operations

2. **Replace in-memory store with DB queries**
   - `create_session`: Add to DB via session, commit, return
   - `week_count`: Query with `WHERE user_id = :uid AND timestamp >= :start_of_week`
   - Remove `_sessions` list and `_id_counter`

3. **Make endpoints async**
   - Both endpoints need `async def` for DB operations

4. **Document the timezone limitation**
   - Add a TODO or accept a `timezone` query parameter on `week_count` so the start-of-week is calculated in the user's local time

5. **Update tests**
   - `tests/test_practice_sessions.py` — replace in-memory state resets with DB fixtures

## Acceptance Criteria

- Practice sessions persist in DB
- No duplicate model definitions
- Week count query is correct for UTC (timezone improvement can be a follow-up)
- All practice tests pass

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/practice.py` | Rewrite |
| `backend/src/schemas/practice.py` | **Create** |
| `backend/tests/test_practice_sessions.py` | Rewrite |
