# Phase 6-02: Decompose useHabits God Hook

## Problem

`frontend/src/features/Habits/hooks/useHabits.ts` is 586 lines, composes 7 nested hooks, and returns 30+ properties. It is the single biggest maintainability risk in the frontend. Understanding habit selection requires tracing 6 levels of indirection. Stale closures are likely due to deep dependency chains.

## Current Structure (7 hooks deep)

```
useHabits()
  ├── useHabitLoader() — API fetch + cache load
  │     └── useHabitMutations() — CRUD operations
  │           └── useHabitReveal() — scaffolding reveal animation
  │                 └── useHabitCrud() — low-level API calls
  ├── useHabitActions() — user-facing actions (log, delete, reorder)
  ├── useHabitStats() — stats fetch per habit
  └── useModalCoordinator() — modal open/close state
```

## Target Structure

```
useHabits() — ~80 lines, composition only
  ├── habitManager (service object, not a hook)
  │     ├── loadHabits() → Promise
  │     ├── updateHabit(id, payload) → Promise
  │     ├── deleteHabit(id) → Promise
  │     └── logUnit(habitId, amount) → Promise
  ├── useHabitStore() — Zustand selectors (read-only)
  └── useHabitUI() — ~40 lines, modal/selection state only
```

## Key Principles

- **Services are not hooks** — `habitManager` is a plain object with async methods, testable without React
- **Hooks are thin** — `useHabits()` subscribes to Zustand and calls service methods. Max 80 lines.
- **UI state is local** — selected habit, open modal, edit mode are component concerns, not global

## Acceptance Criteria

- [ ] `useHabits.ts` is <100 lines
- [ ] `habitManager` service is independently unit-testable
- [ ] No hook nests more than 2 levels deep
- [ ] All existing habit tests pass (behavior unchanged)
- [ ] FlatList doesn't re-render all tiles on modal open (verify with React DevTools)

## Estimated Scope
~350 LoC (restructure, net change is small)
