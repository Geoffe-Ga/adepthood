# phase-4-07: Document magic numbers and add missing explanatory comments

**Labels:** `phase-4`, `documentation`, `cleanup`, `priority-low`
**Epic:** Phase 4 — Polish & Harden
**Estimated LoC:** ~50–80

## Problem

The AGENTS.md explicitly states: "Never introduce magic numbers or clever hacks without explanation." Several magic numbers exist without context:

1. **`HabitUtils.ts:28`** — Stage duration array:
   ```typescript
   const durations = [21, 21, 21, 21, 21, 21, 21, 21, 42, 42];
   ```
   Why are stages 1-8 at 21 days and stages 9-10 at 42 days? This is a core domain concept with no explanation.

2. **`domain/energy.py:50`** — Plan duration:
   ```python
   for offset in range(21):
   ```
   Why 21 days? Is this related to the stage durations above?

3. **`HabitTile.tsx:44`** — Row calculation:
   ```typescript
   const rows = columns === 2 ? 5 : 10;
   ```
   Why 5 or 10? What do these numbers represent?

4. **`routers/auth.py:19`** — Token TTL:
   ```python
   _TOKEN_TTL = timedelta(hours=1)
   ```
   Named constant (good), but why 1 hour? Is this a security choice, UX choice, or arbitrary?

5. **`HabitDefaults.tsx`** — Energy cost/return values:
   ```typescript
   energy_cost: 7, energy_return: 9  // High Flow Activity
   energy_cost: 6, energy_return: 8  // Food Choices
   ```
   What scale are these on? What does 7 mean vs 9?

6. **`GoalModal.tsx`** — Hardcoded style values throughout

## Scope

Add named constants and explanatory comments for all magic numbers.

## Tasks

1. **Extract stage durations to a named constant with explanation**
   ```typescript
   /**
    * Number of days per APTITUDE stage. Stages 1-8 are 21-day cycles
    * (3 weeks each, totaling 24 weeks). Stages 9-10 are 42-day cycles
    * (6 weeks each, totaling 12 weeks). Grand total: 36 weeks.
    */
   export const STAGE_DURATIONS_DAYS = [21, 21, 21, 21, 21, 21, 21, 21, 42, 42];
   ```

2. **Extract energy plan duration to a named constant**
   ```python
   PLAN_DURATION_DAYS = 21  # One stage cycle
   ```

3. **Document the energy scale**
   - Add a comment in `Habits.types.ts` or `HabitDefaults.tsx` explaining the 1-10 scale
   - What does energy_cost represent? What does energy_return represent?

4. **Document row count logic**
   - Why 5 rows for 2 columns and 10 rows for 1 column? Is this about fitting a certain number of tiles on screen?

5. **Document token TTL choice**
   - Add a comment explaining the security/UX tradeoff

6. **Audit for any other unexplained numbers** — search for bare numeric literals in logic (not style values)

## Acceptance Criteria

- All magic numbers in business logic have named constants
- Named constants have JSDoc/docstring comments explaining the "why"
- No bare numeric literals in domain logic (style values are exempt)
- AGENTS.md guideline is satisfied

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitUtils.ts` | Modify (named constants) |
| `frontend/src/features/Habits/HabitDefaults.tsx` | Modify (document energy scale) |
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (document row calc) |
| `backend/src/domain/energy.py` | Modify (named constant) |
| `backend/src/routers/auth.py` | Modify (document TTL) |
