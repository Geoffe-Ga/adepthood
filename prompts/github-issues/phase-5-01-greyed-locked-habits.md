# phase-5-01: Show locked habits as greyed-out tiles instead of hiding them

**Labels:** `phase-5`, `frontend`, `ux`, `priority-medium`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~125

## Problem

The original Habit Milestones prompt specifies:

> "Only first habit (Beige) is fully active on app start. All others greyed out visually and do not display streak/units unless unlocked."

The current implementation **hides** unrevealed habits entirely:

```tsx
// HabitsScreen.tsx:151
data={habits.filter((h) => h.revealed)}
```

This means users only ever see their currently unlocked habits. They have no visual sense of the full 10-stage APTITUDE journey ahead of them. The "skill tree" feeling — seeing what's coming and being motivated to unlock it — is completely lost.

The prompt's vision is better because the APTITUDE program is a 36-week progressive journey. Seeing all 10 tiles (with 9 initially greyed out) communicates scope, creates anticipation, and rewards progress as each new tile "lights up."

## Scope

Replace the `filter` with a visual locked/unlocked state on HabitTile. All 10 tiles always render; locked ones are greyed out, non-interactive, and show a lock icon instead of streak data.

## Tasks

### 1. Remove the `revealed` filter from HabitsScreen

```tsx
// Before:
data={habits.filter((h) => h.revealed)}

// After:
data={habits}
```

Ensure `habits` always contains all 10 habits (including unrevealed ones) from the store.

### 2. Add locked state rendering to HabitTile

When `habit.revealed === false`:
- Set tile opacity to `0.4`
- Apply a desaturated/greyscale filter (or use a muted background color like `#e8e8e8`)
- Replace the streak text with a lock icon (🔒 emoji or a `Lock` icon from lucide-react-native)
- Hide the progress bar entirely (no bar, no markers)
- Show the habit name and stage color as a subtle tint on the border or icon background
- Make the tile non-interactive (`onPress` and `onLongPress` should be no-ops)

### 3. Add a "Coming soon" tooltip or subtitle

Below the habit name on locked tiles, show a small text like:
- "Unlocks in X days" (calculated from `start_date - now`)
- Or "Stage N · Locked" if start date is not yet set

### 4. Update tests

- Test that HabitsScreen renders all 10 tiles (not just revealed ones)
- Test that locked tiles do not respond to press events
- Test that locked tiles show the lock icon, not streak data
- Test the "Unlocks in X days" countdown text

## Acceptance Criteria

- All 10 habit tiles are always visible on the HabitsScreen
- Unlocked habits look and behave exactly as they do now
- Locked habits are visually distinct: greyed out, no progress bar, lock icon
- Locked tiles are not interactive (no modal opens on tap/long-press)
- "Unlocks in X days" countdown is accurate based on `start_date`
- Grid layout remains responsive (2 columns on wide, 1 on narrow)
- No regressions in existing habit interaction flows

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (remove filter) |
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (add locked state rendering) |
| `frontend/src/features/Habits/__tests__/HabitsScreen.test.ts` | Modify (update expectations) |
| `frontend/src/features/Habits/__tests__/HabitTile.test.tsx` | Create or modify |
