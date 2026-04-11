# sec-15: Remaining unbounded string fields in request schemas and models

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A03:2021 — Injection
**Estimated LoC:** ~60

## Problem

The original sec-03 fix added `max_length` constraints to the core request
schemas (journal, botmason, practice, prompt) but missed several request
schemas and model fields that still accept unbounded strings.

### Request schemas still missing constraints (attacker-controlled input)

| File | Field | Current |
|------|-------|---------|
| `backend/src/schemas/habit.py:51` | `HabitCreate.name` | `str` (unbounded) |
| `backend/src/schemas/habit.py:52` | `HabitCreate.icon` | `str` (unbounded) |
| `backend/src/schemas/habit.py:61` | `HabitCreate.stage` | `str` (unbounded) |
| `backend/src/schemas/goal_group.py:13` | `GoalGroupCreate.name` | `str` (unbounded) |
| `backend/src/schemas/goal_group.py:14` | `GoalGroupCreate.icon` | `str | None` (unbounded) |
| `backend/src/schemas/goal_group.py:15` | `GoalGroupCreate.description` | `str | None` (unbounded) |
| `backend/src/schemas/goal_group.py:17` | `GoalGroupCreate.source` | `str | None` (unbounded) |

These are user-facing POST endpoints where an attacker can submit multi-megabyte
payloads that get stored in the database.

### ORM models still missing database-level constraints

| File | Field | Suggested Max |
|------|-------|---------------|
| `backend/src/models/habit.py:18` | `Habit.name` | 255 |
| `backend/src/models/habit.py:19` | `Habit.icon` | 100 |
| `backend/src/models/habit.py:27` | `Habit.notification_frequency` | 20 |
| `backend/src/models/habit.py:33` | `Habit.stage` | 100 |
| `backend/src/models/goal.py:33` | `Goal.tier` | 50 |
| `backend/src/models/goal.py:44` | `Goal.origin` | 255 |
| `backend/src/models/goal_group.py:13-18` | `GoalGroup.name/icon/description/source` | 255/100/2000/255 |
| `backend/src/models/journal_entry.py:33` | `JournalEntry.sender` | 10 |
| `backend/src/models/journal_entry.py:35` | `JournalEntry.tag` | 50 |
| `backend/src/models/practice_session.py:18` | `PracticeSession.reflection` | 5000 |

## Tasks

1. **Add `Field(max_length=...)` to remaining request schemas**
   ```python
   # schemas/habit.py
   class HabitCreate(BaseModel):
       name: str = Field(max_length=255)
       icon: str = Field(max_length=100)
       stage: str = Field(default="", max_length=100)

   # schemas/goal_group.py
   class GoalGroupCreate(BaseModel):
       name: str = Field(max_length=255)
       icon: str | None = Field(default=None, max_length=100)
       description: str | None = Field(default=None, max_length=2000)
       source: str | None = Field(default=None, max_length=255)
   ```

2. **Add `Field(max_length=...)` to remaining ORM model fields**
   - Requires an Alembic migration to alter existing columns

3. **Update tests**
   - Extend `test_input_length_constraints.py` to cover habit and goal_group schemas

## Acceptance Criteria

- All user-facing string fields in request schemas have `max_length`
- All ORM string columns have database-level length constraints
- Pydantic rejects oversized payloads before they reach the database

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/schemas/habit.py` | Add max_length to HabitCreate fields |
| `backend/src/schemas/goal_group.py` | Add max_length to GoalGroupCreate fields |
| `backend/src/models/habit.py` | Add max_length to model fields |
| `backend/src/models/goal.py` | Add max_length to tier, origin |
| `backend/src/models/goal_group.py` | Add max_length to all string fields |
| `backend/src/models/journal_entry.py` | Add max_length to sender, tag |
| `backend/src/models/practice_session.py` | Add max_length to reflection |
| `backend/tests/test_input_length_constraints.py` | Extend with new test cases |
