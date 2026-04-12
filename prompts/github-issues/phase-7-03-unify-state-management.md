# Phase 6-03: Unify Frontend State Management

## Problem

The app uses three concurrent state management approaches with no clear boundaries:

1. **React Context** (AuthContext, ApiKeyContext) — auth + API key
2. **Zustand** (useHabitStore, useStageStore, useUserStore) — domain data
3. **Local useState** (HabitsScreen, JournalScreen, CourseScreen) — UI + domain mixed

This causes redundant state, stale closures, and prop drilling despite having global stores.

## Rules to Establish

| Layer | Tool | What Goes Here |
|-------|------|----------------|
| Auth & App Settings | React Context | JWT token, API key, theme preference |
| Domain Data | Zustand | Habits, stages, journal messages, practices |
| Transient UI | Local useState | Menu visibility, selected item, modal state |

## Specific Changes

1. **Move all API calls out of Zustand stores** — `useStageStore.fetchStages()` (line 57-73) makes API calls inside the store. Stores should be dumb containers. API calls go in services.

2. **Add memoized selectors to Zustand** — currently every component subscribes to the entire store, triggering re-renders on any mutation.

```typescript
// Before: re-renders on ANY habit change
const { habits } = useHabitStore();

// After: re-renders only when this specific habit changes
const habit = useHabitStore(state => state.habitsById[habitId]);
```

3. **Normalize store shape** — replace flat arrays with ID-keyed maps for O(1) lookups.

4. **Remove domain state from useState** — HabitsScreen currently keeps `selectedHabit` in local state AND in Zustand. Pick one.

## Acceptance Criteria

- [ ] Zustand stores have no API calls (pure state + selectors)
- [ ] Each store uses `Record<id, T>` instead of `T[]`
- [ ] Memoized selectors prevent unnecessary re-renders
- [ ] No domain data in local useState (only transient UI state)
- [ ] All existing tests pass

## Estimated Scope
~300 LoC
