# audit-render-02: Memoize HabitTile and stabilize the renderHabitTile closure

**Labels:** `audit-render`, `frontend`, `performance`, `priority-high`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~180  (hard cap 700)

## Problem

`renderHabitTile` in `frontend/src/features/Habits/HabitsScreen.tsx:434-483` is a
fresh closure on every render — it is not wrapped in `useCallback` — so the
Habits `FlatList` receives a new `renderItem` reference each render and
re-renders every visible tile on any state change. Compounding this,
`Habits/HabitTile.tsx` is not `React.memo`'d (the audit notes **zero**
`React.memo` in the entire Habits tree), so rows re-render even when their habit
data is unchanged. Current state (§5.2 render cost, severity **High**): logging
one unit, opening a modal, or any unrelated state change re-renders the whole
visible list — exactly the cost Journal already avoids (§10).

## Scope

Covers wrapping `HabitTile` in `React.memo` with a correct prop comparison and
stabilizing `renderHabitTile` (and any callbacks it passes to tiles, e.g.
log/edit/open handlers) with `useCallback`/`useMemo` so unchanged tiles do not
re-render. Does NOT change tile layout, styling, or interaction behavior — visual
output and behavior must be identical; this is purely a render-cost fix.

## Tasks

1. **Memoize the tile** — wrap the `HabitTile` component export in
   `React.memo` (`frontend/src/features/Habits/HabitTile.tsx`). If props include
   objects/functions, ensure they are stable (see task 2) so the default shallow
   comparison is effective; add a custom comparator only if a prop is
   intentionally derived per-render.
2. **Stabilize the renderer** — wrap `renderHabitTile`
   (`HabitsScreen.tsx:434-483`) in `useCallback` with a correct dependency list,
   and `useCallback`/`useMemo` the per-tile handlers it injects (log, edit, open
   stats/menu) so each tile receives stable prop references.
3. **Render-count test** — in
   `frontend/src/features/Habits/__tests__/`, add a test using
   `@testing-library/react-native` that renders the habit list, records each
   tile's render count (e.g. via a spy in the memoized component or a render
   counter), triggers a single-habit update (log one unit), and asserts only the
   updated row re-renders while sibling rows' counts are unchanged.

## Acceptance Criteria

- [ ] A single-habit update (logging one unit) re-renders only that row, proven
      by the render-count test (sibling tiles' render counts do not increase).
- [ ] `HabitTile` is `React.memo`'d and `renderHabitTile` is a stable
      (`useCallback`) reference across renders that don't change its deps.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (`React.memo`) |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (`useCallback` renderer + handlers) |
| `frontend/src/features/Habits/__tests__/HabitTile.rendercount.test.tsx` | Create (render-count test) |
