# EPIC: Phase 2 — Decompose the Monolith

**Labels:** `epic`, `phase-2`, `priority-high`

## Summary

The Habits feature works but is architecturally unsustainable. `HabitsScreen.tsx` is a 712-line god component managing 16 state variables, 7 modals, 3 mutually exclusive modes (tracked as separate booleans), notification logic, fake stats generation, and emoji picking. There is no global state management — `AppContext.tsx` is empty — so cross-screen communication is impossible.

This phase restructures the codebase for maintainability without changing user-visible behavior. Pure refactoring.

## Success Criteria

- HabitsScreen is under 200 lines
- State management exists and is shared across screens
- Mode management uses a single enum, not three booleans
- Dead code is removed
- Color/spacing constants have a single source of truth

## Sub-Issues

1. `phase-2-01` — Extract HabitsScreen state into a `useHabits` custom hook
2. `phase-2-02` — Replace three mode booleans with a single mode enum
3. `phase-2-03` — Create global state layer (Zustand or Context+Reducer)
4. `phase-2-04` — Delete all dead/empty files
5. `phase-2-05` — Unify color and spacing constants into a single design system
6. `phase-2-06` — Consolidate duplicate pytest/coverage configuration
7. `phase-2-07` — Fix inconsistent backend error response patterns
