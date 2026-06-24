# audit-render-05: Virtualize the Practice catalog

**Labels:** `audit-render`, `frontend`, `performance`, `priority-high`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~300  (hard cap 700)

## Problem

`frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx:90,323` renders
the whole catalog with nested `.map()` calls inside a `ScrollView` — all presets
and drafts are eagerly mounted at once, with no windowing. Current state (§5.2
list virtualization, severity **High**): every catalog item mounts up front, so
the screen janks and memory grows as the catalog expands. This is item §2.6 in
the audit's top user-facing problems. Journal already demonstrates the correct
pattern (`FlatList` with stable `keyExtractor`, `getItemLayout`, windowing —
§10).

## Scope

Covers converting the catalog from a `ScrollView` + nested `.map()` to a
virtualized `SectionList` (if the catalog is grouped into sections such as
presets vs drafts) or `FlatList` with stable `keyExtractor`. Does NOT change the
catalog's layout, grouping, item appearance, or navigation behavior — visual
output and behavior must be identical; only the rendering strategy changes from
eager to windowed.

## Tasks

1. **Model the data** — shape the catalog into the section/flat-list data
   structure the virtualized list expects (sections for presets/drafts, or a
   single flat array with a type discriminator), preserving current order and
   grouping (`PracticeCatalogScreen.tsx:90,323`).
2. **Convert to a virtualized list** — replace the `ScrollView` + `.map()` with
   `SectionList`/`FlatList`; provide a stable `keyExtractor` keyed on a real
   item id (not array index), `renderItem`/`renderSectionHeader`, and any header/
   footer/empty components currently rendered around the maps.
3. **Stabilize render functions** — `useCallback` the `renderItem`/
   `renderSectionHeader`/`keyExtractor` and memoize item components so rows do
   not re-render on unrelated state changes.
4. **Behavior parity test** — in
   `frontend/src/features/Practice/screens/__tests__/`, add a
   `@testing-library/react-native` test that renders the catalog and asserts the
   same items/sections appear and navigation on item press is unchanged.

## Acceptance Criteria

- [ ] The catalog renders through a virtualized `SectionList`/`FlatList` with a
      stable id-based `keyExtractor` — no `.map()` over the catalog inside a
      `ScrollView`.
- [ ] Same items, grouping, order, and press/navigation behavior as before.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify (ScrollView+map → SectionList/FlatList) |
| `frontend/src/features/Practice/screens/__tests__/PracticeCatalogScreen.test.tsx` | Create/Modify (parity test) |
