# phase-2-01: Extract HabitsScreen state into a `useHabits` custom hook

**Labels:** `phase-2`, `frontend`, `refactor`, `priority-high`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~300 (moved, not new)

## Problem

`HabitsScreen.tsx` is 712 lines with 16 `useState` calls (lines 224-239), 10 handler functions (lines 247-458), notification scheduling logic (lines 92-210), and 7 inline modal renders (lines 639-707). It violates single responsibility at every level.

The component currently manages:
- Habit CRUD state (`habits`, `selectedHabit`)
- Modal visibility (6 separate boolean states)
- UI modes (`statsMode`, `quickLogMode`, `editMode`)
- CTA visibility (`showEnergyCTA`, `showArchiveMessage`)
- Emoji picker state (`emojiPickerVisible`, `emojiHabitIndex`)
- Business logic (goal constraint enforcement, streak calculation, notification scheduling)

This makes it extremely difficult to test individual behaviors, add new features, or understand the data flow.

## Scope

Extract all state and handlers into a `useHabits()` custom hook. The component file becomes a thin render layer.

## Tasks

1. **Create `frontend/src/features/Habits/hooks/useHabits.ts`**
   - Move all 16 state declarations from HabitsScreen
   - Move all handler functions: `handleUpdateGoal`, `handleLogUnit`, `handleUpdateHabit`, `handleDeleteHabit`, `handleSaveHabitOrder`, `handleOpenReorderModal`, `generateStatsForHabit`, `handleBackfillMissedDays`, `handleSetNewStartDate`, `handleOnboardingSave`, `handleIconPress`, `handleEmojiSelect`
   - Return a structured object:
     ```typescript
     return {
       habits, selectedHabit, setSelectedHabit,
       modals: { goal, stats, settings, reorder, missedDays, onboarding, emojiPicker },
       mode, setMode,
       actions: { logUnit, updateGoal, updateHabit, deleteHabit, ... },
       ui: { showEnergyCTA, showArchiveMessage, ... },
     };
     ```

2. **Create `frontend/src/features/Habits/hooks/useHabitNotifications.ts`**
   - Move `registerForPushNotificationsAsync` (lines 93-110)
   - Move `scheduleHabitNotification` (lines 113-183)
   - Move `updateHabitNotifications` (lines 186-210)
   - These are pure side-effect functions that don't need to be in the component

3. **Create `frontend/src/features/Habits/hooks/useModalCoordinator.ts`**
   - Manage which modal is open (only one at a time)
   - `openGoalModal(habit)`, `openStatsModal(habit)`, `openSettingsModal(habit)`, etc.
   - `closeAll()`
   - This eliminates 6 separate boolean states

4. **Slim down `HabitsScreen.tsx`**
   - Import and call `useHabits()`
   - The component should only contain: the `return (...)` JSX, `renderHabitTile`, and responsive layout logic
   - Target: under 200 lines

5. **Delete the empty `frontend/src/features/Habits/hooks.ts`** (currently 1 line, placeholder)
   - Replace with the new `hooks/` directory

6. **Update tests**
   - Hook logic can now be tested independently with `renderHook()`
   - Component tests become simpler (mock the hook, test the render)

## Acceptance Criteria

- `HabitsScreen.tsx` is under 200 lines
- All state and logic lives in testable hooks
- No behavioral changes — app works exactly the same
- Existing HabitsScreen tests pass
- New hook unit tests added

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/hooks/useHabits.ts` | **Create** |
| `frontend/src/features/Habits/hooks/useHabitNotifications.ts` | **Create** |
| `frontend/src/features/Habits/hooks/useModalCoordinator.ts` | **Create** |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Rewrite (thin render layer) |
| `frontend/src/features/Habits/hooks.ts` | **Delete** |
