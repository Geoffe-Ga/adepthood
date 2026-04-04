# phase-3-12: Add Course → Journal "Reflection" deep links

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-06, phase-3-11
**Estimated LoC:** ~80–100

## Problem

The spec explicitly requires:

> "Add a 'Reflection' button at the end of each essay that redirects users to the Journal screen for further exploration."

And from the April 6 spec:

> "Deep links: Course → Journal, Map → Practice"

After reading a course essay, users should be prompted to reflect on it in their journal. The reflection should be automatically tagged as `is_stage_reflection: true` and linked to the stage content they just read.

## Scope

Add a "Reflect in Journal" button to course content and wire up the navigation.

## Tasks

1. **Add "Reflect" button to ContentViewer**
   - After "Mark as Read" action (or alongside it): show a "Reflect on this in your Journal" button
   - Tapping navigates to the Journal tab with params: `{ stageReflection: true, contentTitle: "Essay Title", stageNumber: N }`

2. **Update Journal screen to accept course reflection params**
   - If `stageReflection: true` is passed, pre-fill `is_stage_reflection: true` tag
   - Show contextual header: "Reflecting on: [Content Title] — Stage [N]"
   - First message in the session could include the prompt: "What stood out to you from [Content Title]?"

3. **Update navigation types**
   - Add `stageReflection?: boolean`, `contentTitle?: string`, `stageNumber?: number` to Journal's route params

4. **Also add reflection prompts to weekly prompt flow**
   - The Weekly Prompt Banner (phase-3-06) could reference the most recently read course content
   - e.g., "You read [Essay Title] this week. How has it changed your perspective?"

## Acceptance Criteria

- "Reflect" button appears on course content after reading
- Tapping navigates to Journal with stage reflection pre-tagged
- Journal entry is stored with `is_stage_reflection: true`
- Navigation is type-safe (no `as never`)

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/ContentViewer.tsx` | Modify (add Reflect button) |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify (accept reflection params) |
| `frontend/src/features/Journal/ChatInput.tsx` | Modify (pre-fill tag) |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (Journal route params) |
