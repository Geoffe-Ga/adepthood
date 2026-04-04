# phase-3-08: Add journal search and entry tagging UI

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-06
**Estimated LoC:** ~200

## Problem

The spec requires: "Allow users to search through journal entries by keywords" and entries should be tagged as `habit_note`, `stage_reflection`, `practice_note`, or freeform.

Phase-3-03 built the backend search and tagging support. Phase-3-06 built the basic chat UI. This issue adds the search bar and tag filtering UI on the frontend.

## Scope

Add search and tag filtering to the Journal screen.

## Tasks

1. **Add search bar to Journal screen**
   - Text input at top of screen (collapsible — tap a search icon to expand)
   - Debounced search: after 300ms of no typing, call `journal.list({ search: query })`
   - Results replace the main message list, with "X results for 'query'" header
   - Clear button to return to full conversation view

2. **Add tag filter chips**
   - Horizontal row of filter chips below the search bar: "All", "Reflections", "Practice Notes", "Habit Notes"
   - Tapping a chip filters messages by that tag via `journal.list({ tag: 'stage_reflection' })`
   - Active chip is visually highlighted
   - Combinable with search: search within a tag filter

3. **Add tag selector to ChatInput**
   - Small tag icon button next to the send button
   - Tap to reveal a tag picker: checkboxes for `is_stage_reflection`, `is_practice_note`, `is_habit_note`
   - Selected tags are sent with the message create request
   - Tags displayed as small badges on the message bubble (from phase-3-06)

4. **Create `frontend/src/features/Journal/SearchBar.tsx`**
   - Text input with search icon, clear button, debounced callback

5. **Create `frontend/src/features/Journal/TagFilter.tsx`**
   - Horizontal ScrollView of filter chips
   - Props: `activeTag`, `onSelectTag`

## Acceptance Criteria

- Users can search journal entries by keyword
- Results update as the user types (debounced)
- Tag filter chips filter messages by type
- Search and tag filters can be combined
- Messages show their tags as visual badges
- Users can tag messages when sending them

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/SearchBar.tsx` | **Create** |
| `frontend/src/features/Journal/TagFilter.tsx` | **Create** |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify (add search + filters) |
| `frontend/src/features/Journal/ChatInput.tsx` | Modify (add tag selector) |
