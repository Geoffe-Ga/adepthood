# audit-destub-07: Fold course completion into stage overall-progress

**Labels:** `audit-destub`, `backend`, `correctness`, `priority-medium`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~160  (hard cap 700)

## Problem
`backend/src/domain/stage_progress.py:204-207` computes overall stage progress as
`(habits_progress + practice_bonus) / 2` with a **hardcoded `divisor = 2`**. It already fetches
`course_items = _compute_course_items_completed(...)` and returns it in the response, but **silently
drops it from the overall percentage** — course completion never moves the headline number. The
divisor also does not adapt when a stage has no practice or no habits component.
**Current state:** §5.1 class **stub** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 7). The overall
% is **supposed to be real for ship** — it is the primary signal users and the Map screen read.
Supersedes the stage-progress item in `phase-7-05-complete-stubs.md`.

## Scope
**Covers:** folding course completion into `overall_progress` and making the divisor adapt to the
components that actually have data for the stage. **Does NOT cover:** the N+1 query shape of
`compute_stage_progress` (tracked under `audit-async` / `phase-7-04`) or changing the per-component
metrics already returned.

## Tasks
1. **Normalise course completion** — derive a `course_progress` fraction in `[0, 1]` from
   `course_items_completed` against the stage's total course items (add a helper to count the
   denominator, or reuse the existing completion query). A stage with zero course items contributes
   nothing rather than dividing by zero.
2. **Adapt the divisor** — replace the hardcoded `divisor = 2` with the count of components that
   have data for the stage (habits, practice, course). `overall = sum(present components) /
   count(present components)`, guarding the empty case to `0.0`. TDD: tests for (a) all three
   components present, (b) course-only, (c) habits-only, (d) none present → `0.0`, asserting the
   divisor adapts and course completion moves the overall %.
3. **Keep the response shape** — `overall_progress` still rounds to 2 dp; the returned keys are
   unchanged so frontend consumers need no update.

## Acceptance Criteria
- [ ] `overall_progress` reflects course completion (a stage with completed course items and no
      other progress reports > 0).
- [ ] The divisor equals the number of components that have data; a stage with one component
      reports that component's progress directly.
- [ ] A stage with no data returns `overall_progress == 0.0` (no divide-by-zero).
- [ ] Returned response keys are unchanged.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/domain/stage_progress.py` | Modify (fold course in; adaptive divisor) |
| `backend/tests/domain/test_stage_progress.py` | Modify (component-combination + divisor tests) |
