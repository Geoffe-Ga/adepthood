# audit-render-07: Habits FlatList getItemLayout + stop full-remount on breakpoint

**Labels:** `audit-render`, `frontend`, `performance`, `priority-medium`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~200  (hard cap 700)

## Problem

The Habits `FlatList` at `frontend/src/features/Habits/HabitsScreen.tsx:355-369`
has two render-cost problems. Current state (§5.2 list config, severity
**Medium**): (1) it provides no `getItemLayout`, so the list cannot skip
measurement and scroll restoration is slower; and (2) it carries
`key={cols-${columns}}`, which forces a **full remount** of the entire list (and
loses scroll position) on every breakpoint/column change. Separately,
`calculateMissedDays` at `HabitsScreen.tsx:243` loops over all completions on
**every render** even while the stats modal is closed — wasted work that should
be gated behind modal-open.

## Scope

Covers adding `getItemLayout` to the Habits `FlatList`, removing the
`key={cols-${columns}}` remount in favor of letting `numColumns` change without a
full remount (or a re-layout that preserves scroll), and gating
`calculateMissedDays` so it only runs when the stats modal is open. Does NOT
change the grid appearance, column counts per breakpoint, or any stats values —
visual output and behavior must be identical; only wasted work and remounts are
removed.

## Tasks

1. **Add `getItemLayout`** — compute fixed row height (tile height + spacing,
   accounting for `numColumns`) and supply `getItemLayout` to the `FlatList`
   (`HabitsScreen.tsx:355-369`), using a named constant for the row height (no
   magic numbers).
2. **Stop the full remount** — remove `key={cols-${columns}}`. React Native's
   `FlatList` re-lays-out on a `numColumns` change without a `key` remount; if a
   re-layout is required, trigger it without discarding scroll position. Verify
   scroll position survives a breakpoint change.
3. **Gate `calculateMissedDays`** — move/condition the `calculateMissedDays`
   computation (`HabitsScreen.tsx:243`) behind modal-open state (or `useMemo`
   keyed on modal-open + the relevant inputs) so it does not run on every render
   while the modal is closed.
4. **Tests** — in `frontend/src/features/Habits/__tests__/`, add
   `@testing-library/react-native` tests: (a) the list supplies `getItemLayout`
   and the same items render across column counts without a remount, and (b)
   `calculateMissedDays` is not invoked while the modal is closed (spy/counter)
   but produces correct values when opened.

## Acceptance Criteria

- [ ] The Habits `FlatList` provides `getItemLayout` and no longer uses
      `key={cols-${columns}}`; a breakpoint/column change preserves scroll
      position (proven by test).
- [ ] `calculateMissedDays` does not run while the stats modal is closed (proven
      by a spy/counter test) and is correct when open.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (getItemLayout, remove remount key, gate calculateMissedDays) |
| `frontend/src/features/Habits/__tests__/HabitsScreen.flatlist-config.test.tsx` | Create (getItemLayout + scroll + gating tests) |
