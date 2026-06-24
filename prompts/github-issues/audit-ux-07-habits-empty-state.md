# audit-ux-07: Add an empty state to the Habits screen

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-medium`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~160  (hard cap 700)

## Problem

`HabitsScreen.tsx:567-590` (`HabitsContent`) renders the `ErrorBanner`, then either a `LoadingSpinner` or the `HabitList` + `PaginationBar`. When `habits` is an empty array — a brand-new user with zero habits — `HabitList` renders nothing and there is no fallback, so the user sees a blank screen below the top bar with no explanation of what to do next. The Journal feature, by contrast, ships a real empty state (audit §10). Current state: this is a **UX correctness** gap — the screen is functional but offers a dead-end blank for the most important first-run cohort (audit §8 `Habits/HabitsScreen.tsx:567-590`).

## Scope

**Covers:** Adding a `HabitsEmptyState` component that renders when `!loading && !error && habits.length === 0`, with copy that guides the user to add their first habit (and, ideally, a CTA wired to the existing add-habit modal).

**Does NOT:** Change the loading or error branches, pagination, the overflow menu, or the add-habit modal itself. It must not show during loading or when an error banner is up. Pairs with audit-ux-01 (both touch the render tree) — rebase onto whichever lands first.

## Tasks

1. **Build the empty state** — Add a `HabitsEmptyState` component (icon + title + guidance copy, e.g. "No habits yet — add your first to start building momentum"), with an optional "Add a habit" `TouchableOpacity` carrying `accessibilityRole="button"` and an `accessibilityLabel`. Follow Journal's empty-state structure for consistency. TDD: the component renders its title and, if given an `onAdd`, the labeled button.
2. **Wire the empty branch into `HabitsContent`** — In `HabitsContent` (`:565-589`), render `HabitsEmptyState` when `!loading && !error && habits.length === 0`, instead of the empty `HabitList`. Pass through an `onAddHabit` callback from the screen (it already has `state.handleAddHabit` / `modals.open('addHabit')`). TDD: with `habits=[]`, `loading=false`, `error=undefined`, the empty state renders and the list/pagination do not; with `habits=[...]` the list renders and the empty state does not.
3. **Guard against false positives** — Assert the empty state does NOT render while `loading` is true (spinner wins) or while `error` is set (banner + retry path owns the surface). TDD: covers both suppression cases.

## Acceptance Criteria

- [ ] A zero-habit user sees the guidance empty state, not a blank screen.
- [ ] The empty state is suppressed during loading and when an error banner is shown.
- [ ] The optional add-habit CTA opens the existing add-habit modal and is screen-reader labeled.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (render empty branch) |
| `frontend/src/features/Habits/components/HabitsEmptyState.tsx` | **Create** |
| `frontend/src/features/Habits/__tests__/HabitsEmptyState.test.tsx` | **Create** |
