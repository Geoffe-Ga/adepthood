# phase-1-08: Connect HabitsScreen to the habits API (read + write)

**Labels:** `phase-1`, `frontend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-02, phase-1-07
**Estimated LoC:** ~200–300

## Problem

`HabitsScreen.tsx` initializes habits from hardcoded defaults and never contacts the server:

```tsx
const DEFAULT_HABITS: Habit[] = HABIT_DEFAULTS.map((habit) => ({
  ...habit,
  revealed: true,
  completions: [],
}));

const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS);
```

Every handler (`handleLogUnit`, `handleUpdateGoal`, `handleDeleteHabit`, `handleOnboardingSave`) only updates local React state. The `habits` API client is imported and immediately voided: `void habits;`. No data ever reaches the server.

The stats generator returns hardcoded fake data regardless of actual completions:

```tsx
const generateStatsForHabit = (habit: Habit): HabitStatsData => {
  return {
    values: [1, 2, 3, 2, 4, 1, 0],  // Always the same fake data
  };
};
```

## Scope

Make HabitsScreen load data from the API on mount and persist changes back to the server on every mutation.

## Tasks

1. **Load habits from API on mount**
   - Replace `useState<Habit[]>(DEFAULT_HABITS)` with `useState<Habit[]>([])`
   - Add `useEffect` to call `habits.list()` on mount
   - Add loading state and error state
   - Fall back to `HABIT_DEFAULTS` only when the server returns an empty list for a new user (first-time experience)

2. **Persist mutations to the API**
   - `handleLogUnit`: After updating local state, call a `habits.logCompletion(habitId, amount)` endpoint (may need a new backend endpoint for completions specifically)
   - `handleUpdateGoal`: Call `goals.update(goalId, updatedGoal)`
   - `handleUpdateHabit`: Call `habits.update(habitId, payload)`
   - `handleDeleteHabit`: Call `habits.delete(habitId)`
   - `handleOnboardingSave`: Call `habits.create(habit)` for each new habit

3. **Implement optimistic updates**
   - Update local state immediately for responsiveness
   - If API call fails, revert local state and show an error alert
   - This prevents the UI feeling sluggish while waiting for network responses

4. **Replace fake stats with real computation**
   - `generateStatsForHabit` should compute values from `habit.completions`
   - Group completions by day of week for `completionsByDay`
   - Calculate `completionRate` from actual data
   - Calculate `longestStreak` from actual completion timestamps

5. **Replace hardcoded missedDays**
   - `MissedDaysModal` currently receives `[new Date(), new Date(Date.now() - 86400000)]` (always today and yesterday)
   - Calculate actual missed days by comparing completion dates against expected frequency

6. **Add loading/error UI**
   - Show a spinner while habits are loading from the API
   - Show an error banner if the API call fails
   - Retry button for failed loads

## Acceptance Criteria

- Habits load from the server on screen mount
- Creating, updating, deleting, and logging units all persist to the server
- Stats reflect real completion data
- Missed days are calculated from real data
- Loading and error states are visible to the user
- Optimistic updates keep the UI responsive

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (API integration, real stats) |
| `frontend/src/api/index.ts` | Modify (add completion logging, goal update endpoints) |
| `frontend/src/features/Habits/HabitDefaults.tsx` | Keep (used for first-time onboarding only) |
