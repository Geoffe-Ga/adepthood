# phase-3-04: Build Practice backend — UserPractice selection and session linking

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-04
**Estimated LoC:** ~250–300

## Problem

The current practice router (`routers/practice.py`) has basic session CRUD, but the spec requires a richer model. The data model defines three interconnected tables:

```python
class Practice(SQLModel, table=True):
    stage_number: int
    name: str; description: str; instructions: str
    default_duration_minutes: int
    submitted_by_user_id: Optional[int]  # user-submitted practices
    approved: bool = True

class UserPractice(SQLModel, table=True):
    user_id: int; practice_id: int; stage_number: int
    start_date: date; end_date: Optional[date]

class PracticeSession(SQLModel, table=True):
    user_practice_id: int  # NOT direct practice_id
    timestamp: datetime; duration_minutes: float
```

**Key spec requirements missed:**
- Users **pick a Practice per stage** (custom or recommended) — this creates a `UserPractice` record
- `PracticeSession` links to `user_practice_id`, not directly to a practice. The current router incorrectly uses `practice_id`.
- Practices can be **user-submitted** (`submitted_by_user_id`) and require **approval** (`approved: bool`)
- Spec: "Tracks completions (target min 4x/week)"
- Spec: "Reflections can be journaled post-practice" — sessions should be linkable to journal entries

## Scope

Rebuild the practice backend to match the data model's three-table design.

## Tasks

1. **Create `backend/src/routers/practices.py`** (note: separate from practice_sessions)
   - `GET /practices?stage_number=1` — List available practices for a stage (only `approved: true`)
   - `GET /practices/{practice_id}` — Single practice with full instructions
   - `POST /practices/` — Submit a new practice (sets `submitted_by_user_id`, `approved: false`)

2. **Create `backend/src/routers/user_practices.py`**
   - `POST /user-practices/` — User selects a practice for a stage (creates `UserPractice`)
   - `GET /user-practices/` — List user's active practices (one per stage)
   - `GET /user-practices/{id}` — Single user-practice with session history

3. **Rewrite `backend/src/routers/practice.py` → `practice_sessions.py`**
   - `POST /practice-sessions/` — Log a session, linked to `user_practice_id` (not `practice_id`)
   - `GET /practice-sessions/?user_practice_id=X` — List sessions for a user-practice
   - `GET /practice-sessions/week-count` — Sessions this week (existing, updated to use user_practice)

4. **Create schemas**
   - `schemas/practice.py`: `PracticeResponse`, `PracticeCreate` (for user submissions)
   - `schemas/user_practice.py`: `UserPracticeCreate`, `UserPracticeResponse`
   - `schemas/practice_session.py`: `SessionCreate` (with `user_practice_id`), `SessionResponse`

5. **Update models if needed**
   - Ensure `PracticeSession.user_practice_id` FK exists (not `practice_id`)
   - Verify `Practice.submitted_by_user_id` FK exists

6. **Register new routers, write tests**
   - Test: select practice → log sessions → check week count
   - Test: user-submitted practice requires approval
   - Test: only approved practices appear in listings

## Acceptance Criteria

- Three-table model properly implemented: Practice → UserPractice → PracticeSession
- Users select a practice per stage, sessions link to that selection
- User-submitted practices default to unapproved
- Week count uses correct table relationships
- All tests pass

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/practices.py` | **Create** |
| `backend/src/routers/user_practices.py` | **Create** |
| `backend/src/routers/practice.py` | Rewrite → `practice_sessions.py` |
| `backend/src/schemas/practice.py` | **Create** |
| `backend/src/schemas/user_practice.py` | **Create** |
| `backend/src/schemas/practice_session.py` | **Create** |
| `backend/src/main.py` | Modify (register new routers) |
| `backend/tests/test_practices_api.py` | **Create** |
| `backend/tests/test_practice_sessions.py` | Rewrite |
