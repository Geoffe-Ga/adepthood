# phase-5-05: Migrate journal tags from booleans to extensible enum

**Labels:** `phase-5`, `full-stack`, `refactor`, `priority-medium`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~225

## Problem

The original Journal prompt specifies:

> "Tags entries: `habit_note`, `stage_reflection`, freeform"

The current implementation uses three separate boolean columns:

```python
# models/journal_entry.py
is_stage_reflection: bool = False
is_practice_note: bool = False
is_habit_note: bool = False
```

This approach has two problems:

1. **Not extensible.** Adding a new tag type (e.g., `dream_log`, `gratitude`, `course_note`) requires a database migration to add another boolean column. With a proper tags system, it's just a new enum value or string.

2. **Mutual exclusivity is ambiguous.** Can an entry be both `is_stage_reflection` and `is_habit_note`? The booleans allow it, but the UI's TagFilter uses radio-button-style chips that suggest single selection. The data model and UI disagree about cardinality.

3. **The prompt's `freeform` concept is implicit.** An entry with all three booleans `false` is implicitly freeform, but there's no explicit tag for it — making queries like "show me all freeform entries" require a triple-negative WHERE clause.

The prompt's string-based tagging model is better because it scales to new tag types without migrations, makes cardinality explicit (single tag vs. multi-tag), and treats `freeform` as a first-class value.

## Scope

Replace the three boolean columns with a single `tag` string column using a Python `StrEnum`. Update the backend model, schemas, router, and all frontend references.

## Tasks

### 1. Define the tag enum

Create or add to `backend/src/models/journal_entry.py`:

```python
import enum

class JournalTag(str, enum.Enum):
    FREEFORM = "freeform"
    STAGE_REFLECTION = "stage_reflection"
    PRACTICE_NOTE = "practice_note"
    HABIT_NOTE = "habit_note"
```

### 2. Update the JournalEntry model

```python
class JournalEntry(SQLModel, table=True):
    # ... existing fields ...
    tag: str = JournalTag.FREEFORM  # replaces is_stage_reflection, is_practice_note, is_habit_note
```

Keep the column as `str` (not a DB-level enum) so new values can be added without a migration. The Python enum validates at the application layer.

### 3. Create an Alembic migration

- Add the `tag` column with default `"freeform"`
- Backfill existing rows:
  - `is_stage_reflection = True` → `tag = "stage_reflection"`
  - `is_practice_note = True` → `tag = "practice_note"`
  - `is_habit_note = True` → `tag = "habit_note"`
  - All false → `tag = "freeform"`
  - If multiple booleans are true, prefer: `stage_reflection` > `practice_note` > `habit_note` (priority order)
- Drop the three boolean columns

### 4. Update backend router and schemas

In `backend/src/routers/journal.py`:
- Update the `GET /journal/` query filter: replace the boolean-based tag filtering with `WHERE tag = :tag`
- Update `POST /journal/` to accept `tag` instead of three booleans

In `backend/src/schemas/journal.py`:
- `JournalCreate`: replace `is_stage_reflection`, `is_practice_note`, `is_habit_note` with `tag: JournalTag = JournalTag.FREEFORM`
- `JournalResponse`: same replacement

### 5. Update frontend types and API calls

In `frontend/src/api/types.ts` (or wherever journal types live):
```typescript
type JournalTag = 'freeform' | 'stage_reflection' | 'practice_note' | 'habit_note';
```

Update all API calls that send or receive journal entries to use `tag` instead of the three boolean fields.

### 6. Update TagFilter component

In `frontend/src/features/Journal/TagFilter.tsx`:
- Filter chips should map to `JournalTag` values
- "All" shows all entries (no tag filter)
- Each chip filters by `tag === value`

### 7. Update deep-link params

Course → Journal and Practice → Journal deep links currently set boolean flags. Update them to pass `tag: 'stage_reflection'` or `tag: 'practice_note'` instead.

### 8. Write tests

**Backend:**
- Test migration backfills correctly (each boolean combo → correct tag)
- Test `GET /journal/?tag=stage_reflection` returns correct entries
- Test `POST /journal/` with tag field creates the correct entry
- Test that invalid tag values are rejected (422)

**Frontend:**
- Test TagFilter sends correct `tag` query param
- Test deep-link from Course sets `tag: 'stage_reflection'`
- Test deep-link from Practice sets `tag: 'practice_note'`

## Acceptance Criteria

- `JournalEntry` has a single `tag` column instead of three boolean columns
- All existing entries are correctly migrated (no data loss)
- Tag filtering works identically from the user's perspective
- Deep-links from Course and Practice pre-set the correct tag
- Adding a new tag type in the future requires only: (1) add enum value, (2) add UI chip
- Backend rejects invalid tag values with 422

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/models/journal_entry.py` | Modify (add enum, replace booleans) |
| `backend/src/schemas/journal.py` | Modify (replace booleans with tag) |
| `backend/src/routers/journal.py` | Modify (update query filter) |
| `backend/alembic/versions/xxxx_journal_tags.py` | **Create** (migration) |
| `backend/tests/test_journal_api.py` | Modify (update for tag field) |
| `frontend/src/api/types.ts` | Modify (update JournalEntry type) |
| `frontend/src/features/Journal/TagFilter.tsx` | Modify |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify |
| `frontend/src/features/Journal/ChatInput.tsx` | Modify |
| `frontend/src/features/Course/ContentViewer.tsx` | Modify (deep-link param) |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify (deep-link param) |
