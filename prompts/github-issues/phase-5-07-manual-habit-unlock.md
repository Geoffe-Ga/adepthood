# phase-5-07: Add manual habit unlock override setting

**Labels:** `phase-5`, `frontend`, `feature`, `priority-low`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~125

## Problem

The original Habit Milestones prompt specifies:

> "Optional override setting: allow manual unlocking"

Currently, habit unlocking is entirely time-based: the first habit is revealed on onboarding, and subsequent habits are meant to unlock based on their `start_date` (21-day or 42-day intervals). There is no way for a user to manually unlock a habit early.

The prompt's vision is better because:

1. **Power users** may want to explore the full system upfront
2. **Testing and demos** require seeing all habits without waiting 36 weeks
3. **Returning users** who've done the program before shouldn't be gated
4. **The 21-day cadence is a suggestion, not a hard rule** — the APTITUDE program encourages self-directed growth, and artificial gatekeeping contradicts that philosophy

## Scope

Add a "Reveal All Habits" toggle to a settings area (or the 3-dot menu) that unlocks all 10 habits immediately. Also add per-habit unlock via long-press on a locked tile (from phase-5-01).

## Tasks

### 1. Add "Reveal All Habits" to the 3-dot menu

In `HabitsScreen.tsx`, add a new menu item to the overflow menu:
- Label: "Reveal All Habits" (when some are locked) / "Lock Unstarted Habits" (when all are revealed)
- Icon: `Unlock` / `Lock` from lucide-react-native
- Toggling sets all habits' `revealed` to `true` (or resets to time-based logic)

### 2. Add per-habit unlock on locked tiles

This depends on phase-5-01 (greyed-out locked tiles). If a locked tile is long-pressed:
- Show a confirmation: "Unlock [Habit Name] early? The recommended start date is [date]."
- On confirm: set `habit.revealed = true` for just that habit
- On cancel: no-op

If phase-5-01 is not yet complete, skip this task — it only makes sense with visible locked tiles.

### 3. Persist the unlock state

The `revealed` field is already on the `Habit` type. Ensure:
- Manual unlocks persist to AsyncStorage (already happens via the habit store)
- Manual unlocks sync to the backend via `PUT /habits/{id}` if `revealed` is a server-side field
- If `revealed` is client-only, persist it in the local habit store

### 4. Add a visual indicator for manually-unlocked habits

Habits that were unlocked before their `start_date` should have a subtle indicator:
- Small badge or icon showing they were "early unlocked"
- Or simply show them at full opacity with a dotted border (vs. solid border for naturally unlocked)

This is optional polish — don't over-engineer it. A simple approach: if `revealed === true && start_date > now`, the tile is "early unlocked."

### 5. Write tests

- Test "Reveal All Habits" menu item sets all habits to `revealed: true`
- Test toggling back resets to time-based reveal logic
- Test per-habit unlock sets only the targeted habit
- Test that manually unlocked habits persist after app reload
- Test early-unlock indicator logic

## Acceptance Criteria

- 3-dot menu includes a "Reveal All Habits" / "Lock Unstarted Habits" toggle
- Toggling reveals/hides all habit tiles immediately
- Long-pressing a locked tile (if phase-5-01 is complete) offers per-habit unlock
- Unlock state persists across app restarts
- Manually unlocked habits are visually distinguishable from naturally unlocked ones
- No regressions in the time-based unlock flow (it still works when the override is off)

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (add menu item) |
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (add long-press unlock on locked tiles) |
| `frontend/src/features/Habits/hooks/useHabits.ts` | Modify (add revealAll / lockUnstarted actions) |
| `frontend/src/features/Habits/__tests__/ManualUnlock.test.tsx` | **Create** |
