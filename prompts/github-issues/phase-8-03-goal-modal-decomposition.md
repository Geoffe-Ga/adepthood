# phase-8-03: Decompose GoalModal into per-section components

**Labels:** `phase-8`, `frontend`, `architecture`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~300 (moves + extracted props interfaces)

## Problem

`frontend/src/features/Habits/components/GoalModal.tsx` is **1,371 lines**
— the largest component file in the app. It contains the goal editor's
tier sections, the unit editor, the log-date stepper, frequency pickers,
and their styles in one file. Current state: a single default export with
multiple internal sub-render functions; any goal-editing change forces a
full-file review, and test selectors reach deep into one tree.

(`OnboardingModal.tsx` at 1,216 lines has the same disease; it is left for
a follow-up issue once this one establishes the extraction pattern.)

## Scope

Mechanical decomposition only — no behavior change, no visual change.
Extract the modal's major sections into sibling components under
`components/goal-modal/`, each owning its props interface and styles.
Existing tests must pass unchanged (same testIDs, same accessibility
labels).

## Tasks

1. **Extract section components** (one per major UI region)
   - `goal-modal/TierSection.tsx` — the per-tier (low/clear/stretch) target
     editor block.
   - `goal-modal/LogDateStepper.tsx` — the backdate stepper
     (the piece covered by `GoalModal.test.tsx`'s log-date cases).
   - `goal-modal/FrequencyPicker.tsx` — frequency + frequency_unit +
     days_of_week controls.
   - Keep state in `GoalModal`; sections receive values + callbacks.

2. **Extract styles**
   - Move section-specific styles next to each component; shared styles
     stay in `GoalModal` or a `goal-modal/styles.ts`.

3. **Verify zero behavior change**
   - `GoalModal.test.tsx` and `HabitsScreen` integration tests pass without
     edits (testIDs preserved).
   - eslint `max-lines-per-function` and sonarjs complexity warnings for
     this file drop to zero without any disable comments.

## Acceptance Criteria

- `GoalModal.tsx` < 450 lines; each extracted component < 350.
- All existing Habits tests pass **unchanged**.
- No new eslint warnings; no `eslint-disable` anywhere in the diff.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/components/goal-modal/TierSection.tsx` | **Create** |
| `frontend/src/features/Habits/components/goal-modal/LogDateStepper.tsx` | **Create** |
| `frontend/src/features/Habits/components/goal-modal/FrequencyPicker.tsx` | **Create** |
| `frontend/src/features/Habits/components/GoalModal.tsx` | Modify |
