# phase-3-10: Add post-practice reflection → Journal linking

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-06, phase-3-09
**Estimated LoC:** ~100–150

## Problem

The spec states: "Reflections can be journaled post-practice." The data model supports this:

```python
class JournalEntry(SQLModel, table=True):
    practice_session_id: Optional[int]  # links to the practice session
    user_practice_id: Optional[int]     # links to the user's practice
    is_practice_note: bool = False
```

After completing a timed practice session, users should be able to write a reflection that is automatically tagged as a practice note and linked to the specific session.

## Scope

Add the post-practice → Journal linking flow.

## Tasks

1. **Add "Write Reflection" button to practice session completion**
   - After saving a practice session (in PracticeTimer completion flow):
     - Show a "Write a Reflection?" prompt
     - "Yes" → navigate to Journal screen with params: `{ practiceSessionId, userPracticeId, preTag: 'practice_note' }`
     - "Skip" → return to practice selection

2. **Update Journal screen to accept navigation params**
   - If `practiceSessionId` is passed, pre-fill the ChatInput tag with `is_practice_note: true`
   - Show a contextual header: "Reflection on [Practice Name] — [Duration] minutes"
   - The created journal entry will have `practice_session_id` and `is_practice_note: true` set automatically

3. **Update navigation types**
   - Add `practiceSessionId?` and `userPracticeId?` to Journal's route params in `RootTabParamList`

4. **Show linked practice info on journal entries**
   - In `MessageBubble.tsx`: if a message has `practice_session_id`, show a small "Practice" badge with the practice name and duration
   - Tapping the badge could navigate to the Practice tab (optional)

## Acceptance Criteria

- After a practice session, user is prompted to write a reflection
- Navigating to Journal pre-fills the practice link and tag
- Journal entry is stored with `practice_session_id` and `is_practice_note: true`
- Practice-linked entries show a visual indicator in the chat history

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeTimer.tsx` | Modify (add reflection prompt) |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify (accept practice params) |
| `frontend/src/features/Journal/ChatInput.tsx` | Modify (pre-fill tags) |
| `frontend/src/features/Journal/MessageBubble.tsx` | Modify (practice badge) |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (add Journal route params) |
