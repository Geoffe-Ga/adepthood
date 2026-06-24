# audit-render-09: Inline-literal & O(N²) lookup cleanup

**Labels:** `audit-render`, `frontend`, `performance`, `priority-low`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~180  (hard cap 700)

## Problem

Several lower-severity render costs remain scattered across the tree. Current
state (§5.2 render cost, severity **Lower**): `Course/StageSelector.tsx:55-60`
runs an O(N²) `stages.find()` per pill on every render (a linear scan inside a
per-pill loop); and three sites create fresh literals every render —
`Practice/FrequencyBanner.tsx:71` (inline style object),
`navigation/BottomTabs.tsx:118-139` (inline `headerRight` component), and
`components/DatePicker.tsx:217` (per-render `Date` factory). Inline style objects
and inline components defeat memoization in their children; per-render `Date`
construction is wasted allocation.

## Scope

Covers (1) replacing the O(N²) `stages.find()` in `StageSelector` with a single
keyed `Map` built once (`useMemo`) and looked up in O(1); and (2) hoisting or
memoizing the inline style/component/`Date` literals at the three named sites so
they are stable across renders. Does NOT change the rendered pills, banner,
header, or date-picker appearance or behavior — visual output and behavior must
be identical.

## Tasks

1. **Keyed Map for StageSelector** — at `Course/StageSelector.tsx:55-60`, build a
   `Map<stageId, stage>` once via `useMemo` (keyed on `stages`) and replace each
   per-pill `stages.find(...)` with an O(1) `map.get(...)`.
2. **Hoist/memoize FrequencyBanner style** — at `Practice/FrequencyBanner.tsx:71`,
   move the inline style object into a `StyleSheet.create` entry (or `useMemo` if
   it depends on props) so it is not reallocated each render.
3. **Stabilize BottomTabs headerRight** — at `navigation/BottomTabs.tsx:118-139`,
   hoist the inline `headerRight` component to a stable reference (module-level
   component or `useCallback`) so it is not redefined per render.
4. **Stabilize DatePicker Date factory** — at `components/DatePicker.tsx:217`,
   avoid constructing `Date` objects on every render; compute via `useMemo`/
   constants keyed on the relevant inputs.
5. **Tests** — add/extend `@testing-library/react-native` tests asserting the
   `StageSelector` still highlights the correct stage and that the banner/header/
   date-picker render identically (snapshot/behavior).

## Acceptance Criteria

- [ ] `StageSelector` uses an O(1) keyed `Map` lookup instead of per-pill
      `stages.find()`; selected-stage highlighting is unchanged (proven by test).
- [ ] `FrequencyBanner` style, `BottomTabs` `headerRight`, and `DatePicker` date
      construction are stable across renders (hoisted/memoized).
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/StageSelector.tsx` | Modify (keyed Map lookup) |
| `frontend/src/features/Practice/FrequencyBanner.tsx` | Modify (hoist style) |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (stabilize headerRight) |
| `frontend/src/components/DatePicker.tsx` | Modify (memoize Date factory) |
| `frontend/src/features/Course/__tests__/StageSelector.test.tsx` | Create/Modify (highlight parity test) |
