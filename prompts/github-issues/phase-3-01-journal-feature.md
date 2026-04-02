# phase-3-01: Build Journal backend router and frontend screen

**Labels:** `phase-3`, `frontend`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-03, phase-1-10
**Estimated LoC:** ~300 backend, ~300 frontend

## Problem

The Journal screen is a placeholder:

```tsx
const JournalScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Journal Screen</Text>
    </View>
  );
};
```

The `api/index.ts` has a `journal.create()` method defined but the frontend never calls it, and there's no backend `/journal` endpoint to receive it. The `JournalEntry` SQLModel exists in `models/journal_entry.py` with fields for `content`, `sender` ('user' or 'bot'), `timestamp`, and `user_id`.

The README describes the Journal as: "Reflect daily and chat with Robot Mason, your Liminal Trickster Mystic guide." This implies both free-form journaling and AI-assisted conversation.

## Scope

Build a functional journal with create/list/view. AI chat can be a follow-up issue — start with the basic journaling CRUD.

## Tasks

### Backend

1. **Create `backend/src/routers/journal.py`**
   - `POST /journal/` — Create a new journal entry (auth-gated, user_id from token)
   - `GET /journal/` — List entries for the current user, paginated, newest first
   - `GET /journal/{entry_id}` — Get a single entry (owned by current user)
   - `DELETE /journal/{entry_id}` — Delete an entry

2. **Create `backend/src/schemas/journal.py`**
   - `JournalEntryCreate`: `content: str`, optional `reflection_prompt: str`
   - `JournalEntryResponse`: `id`, `content`, `sender`, `timestamp`, `user_id`
   - `JournalEntryList`: paginated response with `items: list[JournalEntryResponse]`, `total: int`

3. **Register router in `main.py`**

4. **Write tests** — `tests/test_journal_api.py`
   - Create entry, list entries, get by ID, delete, auth-gated

### Frontend

5. **Rewrite `frontend/src/features/Journal/JournalScreen.tsx`**
   - **Entry list view**: FlatList of journal entries, newest first
   - **Entry creation**: Text input area with "Save" button
   - **Entry detail**: Tap an entry to view full content
   - Pull-to-refresh to reload from API

6. **Create `frontend/src/features/Journal/JournalEntry.tsx`**
   - Renders a single journal entry card (date, preview text, tap to expand)

7. **Create `frontend/src/features/Journal/JournalCompose.tsx`**
   - Text input area (multiline)
   - Optional: reflection prompt displayed above the input
   - Save button that calls `journal.create()`
   - Loading state while saving

8. **Update `api/index.ts`**
   - Add `journal.list()` and `journal.get(id)` methods (currently only `journal.create()` exists)

9. **Update Journal styles** — `Journal.styles.ts` currently has minimal placeholder styles

## Acceptance Criteria

- Users can write and save journal entries
- Entries persist in the database
- Entry list loads on screen mount
- Entries belong to the authenticated user (no cross-user access)
- Backend tests cover all CRUD operations

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` | **Create** |
| `backend/src/schemas/journal.py` | **Create** |
| `backend/src/main.py` | Modify (register journal router) |
| `backend/tests/test_journal_api.py` | **Create** |
| `frontend/src/features/Journal/JournalScreen.tsx` | Rewrite |
| `frontend/src/features/Journal/JournalEntry.tsx` | **Create** |
| `frontend/src/features/Journal/JournalCompose.tsx` | **Create** |
| `frontend/src/features/Journal/Journal.styles.ts` | Modify |
| `frontend/src/api/index.ts` | Modify (add journal.list, journal.get) |
