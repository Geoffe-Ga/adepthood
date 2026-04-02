# phase-3-03: Build Journal backend — chat messages, tagging, and search

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-03
**Estimated LoC:** ~250–300

## Problem

The spec describes the Journal as a **chat interface with BotMason**, not a simple text entry form. The `JournalEntry` model reflects this:

```python
class JournalEntry(SQLModel, table=True):
    message: str
    sender: str  # 'user' or 'bot'
    user_id: int
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: Optional[int]   # links to a practice session
    user_practice_id: Optional[int]      # links to a user's practice
    timestamp: datetime
```

Key spec requirements:
- "Store and display past conversations in a scrollable feed"
- "Allow users to search through journal entries by keywords"
- Tags: `habit_note`, `stage_reflection`, `practice_note`, freeform
- Practice sessions can link to journal reflections via `practice_session_id`
- BotMason AI responses are stored as entries with `sender: 'bot'`

No backend router exists for any of this.

## Scope

Build the Journal API for chat message storage, search, and tagging. AI integration is a separate issue (phase-3-07).

## Tasks

1. **Create `backend/src/routers/journal.py`**
   - `POST /journal/` — Create a message (auth-gated). Sets `sender: 'user'`. Accepts optional tags (`is_stage_reflection`, etc.) and optional `practice_session_id` for post-practice reflections.
   - `GET /journal/` — List messages for current user, paginated, newest first. Supports query params:
     - `?search=keyword` — full-text search across message content
     - `?tag=stage_reflection` — filter by tag type
     - `?practice_session_id=123` — filter by linked practice
     - `?limit=50&offset=0` — pagination
   - `GET /journal/{entry_id}` — Single entry
   - `DELETE /journal/{entry_id}` — Delete (user's own only)
   - `POST /journal/bot-response` — Internal endpoint for storing BotMason responses (called by AI integration layer, not directly by frontend)

2. **Create `backend/src/schemas/journal.py`**
   - `JournalMessageCreate`: `message: str`, `is_stage_reflection: bool = False`, `is_practice_note: bool = False`, `is_habit_note: bool = False`, `practice_session_id: int | None = None`, `user_practice_id: int | None = None`
   - `JournalMessageResponse`: All fields + `id`, `sender`, `timestamp`
   - `JournalListResponse`: `items: list[JournalMessageResponse]`, `total: int`, `has_more: bool`

3. **Implement search**
   - For MVP: `ILIKE '%keyword%'` on `message` field
   - For production: PostgreSQL full-text search with `tsvector`/`tsquery`
   - Index the `message` column for search performance

4. **Register router, write tests**
   - Test search returns matching entries
   - Test tag filtering works
   - Test practice session linking
   - Test user can only see own entries
   - Test pagination

## Acceptance Criteria

- Journal entries stored with sender, tags, and optional practice links
- Search by keyword returns matching entries
- Tag filtering works correctly
- Pagination works
- User isolation enforced

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` | **Create** |
| `backend/src/schemas/journal.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_journal_api.py` | **Create** |
