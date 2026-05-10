# ritual-05: Frequency / aspect copy endpoint

**Labels:** `ritual-practice`, `backend`, `feature`, `priority-medium`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-02 (preset practices seeded), `CourseStage` rows seeded
**Estimated LoC:** ~250

## Problem

The Practice screen needs to render this exact copy:

> "You are in the **<color>** frequency of APTITUDE. That means you are
> working on **<aspect of wholeness for that color>**. Your practice is
> **<practice>** but you are encouraged to replace it if another tradition
> has a practice that deals with **<aspect>** that calls to you more."

Today the frontend would have to fetch the user's current stage, then the
matching `CourseStage` for color/aspect, then their `UserPractice`, then the
underlying `Practice` for the name — four round trips and a string assembly
in the client. Move that into one server endpoint so the copy is consistent
and the client can render it from a single payload.

## Scope

Add `GET /user-practices/current/frequency` returning the assembled banner
data plus the structured fields for client formatting.

## Tasks

1. **Endpoint** — `backend/src/routers/user_practices.py`
   - `GET /user-practices/current/frequency`
   - Resolves `current_stage` from `StageProgress` (default 1 if no progress
     row yet).
   - Loads the matching `CourseStage` (`spiral_dynamics_color`, `aspect`).
   - Loads the user's active `UserPractice` for that stage (the partial
     unique index from existing code guarantees ≤ 1 active row).
   - If no active `UserPractice`, falls back to the seeded preset for that
     stage (look up `Practice` by `(stage_number, name)` matching the
     `PRESET_PRACTICES` table — keep the lookup keyed on a small
     `STAGE_TO_PRESET_NAME` map exported from `seed_practices.py` so the
     two stay in sync).

2. **Response schema** — `backend/src/schemas/frequency.py`
   ```python
   class FrequencyResponse(BaseModel):
       stage_number: int
       color: str            # e.g. "Orange"
       aspect: str           # e.g. "Mind"
       practice_name: str    # effective_name (custom or catalog)
       practice_id: int
       user_practice_id: int | None  # null if showing the unselected default
       banner_text: str      # fully formatted English string
   ```
   - `banner_text` is rendered server-side from a constant template so
     wording changes happen in one place. Keep the template as a module-level
     constant string with `{color} / {aspect} / {practice_name}` slots.

3. **Empty-progress edge case**
   - If `StageProgress` doesn't exist for the user yet, treat them as stage
     1 (matches the existing `is_stage_unlocked` invariant). The fallback
     logic above naturally handles "no UserPractice yet" by surfacing the
     preset.

4. **Tests** (`backend/tests/test_frequency_endpoint.py`)
   - User at stage 1 with no `UserPractice` returns the seeded preset and
     the Beige/Body banner.
   - User at stage 5 with a `UserPractice` selected returns the user's
     practice name, Orange/Mind banner.
   - User with `custom_name` set on their `UserPractice` returns the
     `custom_name` (verifies `effective_name` plumbing from ritual-03).
   - Banner template renders the three slots in the documented order; a
     snapshot test pins the exact wording so accidental copy changes show up
     in PR diffs.
   - Unauthenticated request returns 401.

## Acceptance Criteria

- Single GET returns everything the banner needs.
- Copy template lives server-side; clients never assemble it from parts.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/routers/user_practices.py` | Modify (add endpoint) |
| `backend/src/schemas/frequency.py` | **Create** |
| `backend/src/seed_practices.py` | Modify (export `STAGE_TO_PRESET_NAME`) |
| `backend/tests/test_frequency_endpoint.py` | **Create** |

## If you blow the budget

This issue is small enough that splitting is unlikely to help. If lookups get
chatty (more than one DB round-trip per call), consolidate via a single
joined query rather than splitting the issue.
