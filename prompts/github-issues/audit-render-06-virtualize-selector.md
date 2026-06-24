# audit-render-06: Virtualize the Practice selector

**Labels:** `audit-render`, `frontend`, `performance`, `priority-high`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~160  (hard cap 700)

## Problem

`frontend/src/features/Practice/PracticeSelector.tsx:85` renders the stage's
practice list with `.map()` inside a `View` nested under a `ScrollView`. Current
state (§5.2 list virtualization, severity **High**): the entire list is eagerly
mounted with no windowing, so the selector janks as the number of practices
grows — the same anti-pattern as the catalog (§5/audit-render-05) and the
opposite of the Journal gold-standard list (§10).

## Scope

Covers converting the selector's `.map()` to a virtualized `FlatList` with a
stable, id-based `keyExtractor`. Does NOT change the selector's appearance, item
order, selection behavior, or the surrounding screen layout — visual output and
behavior must be identical; only eager mounting becomes windowed.

## Tasks

1. **Convert to FlatList** — replace the `.map()` at
   `PracticeSelector.tsx:85` with a `FlatList` (or, if the selector must remain
   inside an outer `ScrollView` with other content, scope the outer scroll so the
   `FlatList` virtualizes correctly — avoid nesting a vertical `FlatList` inside a
   vertical `ScrollView`; restructure so the list owns its scroll).
2. **Stable keys + stable renderers** — supply a `keyExtractor` keyed on the
   practice id, `useCallback` the `renderItem`, and memoize the row component so
   rows do not re-render on unrelated state changes.
3. **Parity test** — in `frontend/src/features/Practice/__tests__/`, add a
   `@testing-library/react-native` test asserting the same practices render in the
   same order and that selecting a practice fires the same callback as before.

## Acceptance Criteria

- [ ] The selector renders through a virtualized `FlatList` with a stable
      id-based `keyExtractor` — no `.map()` over the practice list inside a
      `ScrollView`.
- [ ] Same items, order, and selection behavior as before.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeSelector.tsx` | Modify (.map → FlatList) |
| `frontend/src/features/Practice/__tests__/PracticeSelector.test.tsx` | Create/Modify (parity test) |
