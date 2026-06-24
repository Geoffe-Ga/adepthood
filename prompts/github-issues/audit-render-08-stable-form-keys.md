# audit-render-08: Stable keys in Practice editable forms

**Labels:** `audit-render`, `frontend`, `performance`, `priority-medium`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~220  (hard cap 700)

## Problem

Three Practice editable forms key their dynamic rows by array index or a
module-level counter instead of a stable id:
`frontend/src/features/Practice/configurator/forms/SenseGroundingForm.tsx:41`,
`frontend/src/features/Practice/configurator/forms/CardMeditationForm.tsx:122-130`,
and `frontend/src/features/Practice/configurator/views/IntervalBellView.tsx:35-43`.
Current state (§5.2 unstable keys, severity **Medium**): when a user reorders or
deletes a row, React reuses the wrong component instances, so per-row state
(focus, in-progress edits, animation state) **remaps to the wrong row** — a
correctness bug, not just a render cost. Indexed/counter keys also defeat
reconciliation, causing extra re-renders.

## Scope

Covers replacing index/counter-based keys with stable per-row ids across the
three forms — generating a stable id when a row is created (not derived from
position) and keying lists, `map`s, and any `FlatList`/`keyExtractor` on it. Does
NOT change the forms' fields, validation, layout, or submit behavior — visual
output and behavior must be identical except that row state now tracks the
correct row across reorder/delete.

## Tasks

1. **Add stable ids to row models** — when a row is added in each form's state,
   assign a stable id (e.g. a generated uuid/nanoid or a monotonic id stored on
   the row object, not the array index). Persist it with the row so it survives
   reorder/delete.
2. **Key by the stable id** — update the `key=` (and any `keyExtractor`) at
   `SenseGroundingForm.tsx:41`, `CardMeditationForm.tsx:122-130`, and
   `IntervalBellView.tsx:35-43` to use the row id instead of index/module
   counter.
3. **Tests** — in
   `frontend/src/features/Practice/configurator/__tests__/`, add
   `@testing-library/react-native` tests for each form: enter distinct state in
   two rows, reorder/delete a row, and assert each remaining row keeps its own
   state (proving keys are stable and state no longer remaps).

## Acceptance Criteria

- [ ] Each form's dynamic rows are keyed by a stable id; reordering or deleting a
      row keeps per-row state attached to the correct row, proven by tests.
- [ ] No row key derives from array index or a module-level counter.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/configurator/forms/SenseGroundingForm.tsx` | Modify (stable row ids/keys) |
| `frontend/src/features/Practice/configurator/forms/CardMeditationForm.tsx` | Modify (stable row ids/keys) |
| `frontend/src/features/Practice/configurator/views/IntervalBellView.tsx` | Modify (stable row ids/keys) |
| `frontend/src/features/Practice/configurator/__tests__/form-stable-keys.test.tsx` | Create (per-form state-tracking tests) |
