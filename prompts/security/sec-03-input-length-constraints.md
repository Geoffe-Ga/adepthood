# sec-03: Unbounded string fields enable payload abuse

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A03:2021 — Injection
**Estimated LoC:** ~80

## Problem

Multiple request schemas and ORM models accept unbounded string fields. An
attacker can send multi-megabyte payloads that consume database storage, slow
queries, and potentially exhaust memory during JSON parsing.

### Affected Schemas (request DTOs — attacker-controlled input)

| File | Field | Current | Suggested Max |
|------|-------|---------|---------------|
| `backend/src/schemas/journal.py:19` | `JournalMessageCreate.message` | `str` (unbounded) | 10,000 |
| `backend/src/schemas/journal.py:28` | `JournalBotMessageCreate.message` | `str` (unbounded) | 10,000 |
| `backend/src/schemas/botmason.py:11` | `ChatRequest.message` | `str` (unbounded) | 5,000 |
| `backend/src/schemas/practice.py:29` | `PracticeCreate.name` | `str` (unbounded) | 255 |
| `backend/src/schemas/practice.py:30` | `PracticeCreate.description` | `str` (unbounded) | 2,000 |
| `backend/src/schemas/practice.py:31` | `PracticeCreate.instructions` | `str` (unbounded) | 10,000 |
| `backend/src/schemas/practice.py:88` | `PracticeSessionCreate.reflection` | `str | None` (unbounded) | 5,000 |
| `backend/src/schemas/prompt.py:23` | `PromptSubmit.response` | `str` (unbounded) | 10,000 |

### Affected Models (database columns — defense in depth)

| File | Field | Current | Suggested Max |
|------|-------|---------|---------------|
| `backend/src/models/journal_entry.py:32` | `JournalEntry.message` | `str` | 10,000 |
| `backend/src/models/practice.py:9-11` | `Practice.name/description/instructions` | `str` | 255/2,000/10,000 |
| `backend/src/models/prompt_response.py:18-19` | `PromptResponse.question/response` | `str` | 1,000/10,000 |
| `backend/src/models/goal.py:31-37` | `Goal.title/description/target_unit/frequency_unit` | `str` | 255/2,000/50/50 |

## Tasks

1. **Add `Field(max_length=...)` to all request schemas**
   ```python
   from pydantic import BaseModel, Field

   class JournalMessageCreate(BaseModel):
       message: str = Field(max_length=10_000)
   ```

2. **Add `Field(max_length=...)` to ORM model columns**
   - This adds database-level `VARCHAR(N)` constraints as a second layer
   - Will require an Alembic migration to alter existing columns

3. **Add `min_length=1` where empty strings are invalid**
   - `ChatRequest.message`, `PracticeCreate.name`, `PromptSubmit.response`
     should reject empty/whitespace-only input

4. **Update tests**
   - Test that oversized payloads return 422
   - Test that empty strings are rejected where appropriate

## Acceptance Criteria

- All user-facing string fields have explicit `max_length` constraints
- Pydantic rejects oversized payloads before they reach the database
- ORM models have matching database-level constraints
- Tests cover boundary cases (at limit, over limit, empty)

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/schemas/journal.py` | Add max_length to message fields |
| `backend/src/schemas/botmason.py` | Add max_length to ChatRequest.message |
| `backend/src/schemas/practice.py` | Add max_length to all string fields |
| `backend/src/schemas/prompt.py` | Add max_length to PromptSubmit.response |
| `backend/src/models/journal_entry.py` | Add max_length to message |
| `backend/src/models/practice.py` | Add max_length to name/description/instructions |
| `backend/src/models/prompt_response.py` | Add max_length to question/response |
| `backend/src/models/goal.py` | Add max_length to title/description/units |
| `backend/tests/` | Add payload size validation tests |
