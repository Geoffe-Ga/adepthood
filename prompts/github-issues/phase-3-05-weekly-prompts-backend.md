# phase-3-05: Build PromptResponse backend — weekly reflection prompts

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-03
**Estimated LoC:** ~150–200

## Problem

The spec states: "Include an optional feature where BotMason provides weekly prompts for self-reflection and journaling based on the documents submitted to it. Save user responses as part of the journal history."

The `PromptResponse` model exists:

```python
class PromptResponse(SQLModel, table=True):
    week_number: int
    question: str
    response: str
    timestamp: datetime
    user_id: int
```

But nothing serves or collects these. The weekly prompts are a structured journaling feature distinct from the freeform BotMason chat — they have a specific question, a specific week, and a stored response.

## Scope

Build the backend for weekly reflection prompts: serving the current week's prompt and storing responses.

## Tasks

1. **Create `backend/src/routers/prompts.py`**
   - `GET /prompts/current` — Return the prompt for the user's current week (derived from `StageProgress` start date or signup date). Returns `week_number`, `question`, and whether the user has already responded.
   - `GET /prompts/history` — List all past prompts and responses for the user, paginated
   - `POST /prompts/{week_number}/respond` — Submit a response to a prompt. Creates a `PromptResponse` and optionally also creates a `JournalEntry` with `is_stage_reflection: true` so it appears in journal history.
   - `GET /prompts/{week_number}` — Get a specific prompt and its response

2. **Create `backend/src/schemas/prompt.py`**
   - `PromptResponse`: `week_number`, `question`, `response`, `timestamp`, `has_responded`
   - `PromptSubmit`: `response: str`

3. **Seed weekly prompts**
   - Create a table or config file with 36 weeks of reflection prompts (one per week of the APTITUDE program)
   - For MVP: seed at least 10 prompts for the first 10 weeks
   - Prompts should be stage-appropriate (weeks 1-3 = Beige stage themes, etc.)

4. **Link to Journal**
   - When a user submits a prompt response, also create a `JournalEntry` with:
     - `message: response_text`
     - `sender: 'user'`
     - `is_stage_reflection: true`
   - This ensures prompt responses appear in the journal history alongside chat messages

5. **Register router, write tests**

## Acceptance Criteria

- Current week's prompt is served based on user's program timeline
- Responses are stored and linked to journal history
- Prompt history is paginated and retrievable
- Duplicate responses for the same week are prevented (or update existing)

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/prompts.py` | **Create** |
| `backend/src/schemas/prompt.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_prompts_api.py` | **Create** |
