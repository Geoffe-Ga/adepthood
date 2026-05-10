# ritual-03: User practice customization (per-user overrides)

**Labels:** `ritual-practice`, `backend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-01 (mode_config exists)
**Estimated LoC:** ~400

## Problem

Presets are a starting point — the spec says "Practices can be changed".
A user should be able to rename their preset ("My Morning Sit"), shorten the
duration, change the BPM, add or remove interval bells, or rewrite the
sense-grounding prompts — **without** mutating the shared catalog row.

We already have `UserPractice` mapping `(user, stage) → practice`. We need
optional per-user override fields layered on top.

## Scope

Add nullable override columns to `UserPractice`, expose a `PATCH` endpoint
for editing them, and provide a single `effective_config()` resolver so the
frontend never has to merge by hand.

## Tasks

1. **Extend `UserPractice` model** (`backend/src/models/user_practice.py`)
   - Add nullable columns:
     - `custom_name: str | None` (≤255 chars).
     - `mode_config_override: dict[str, Any] | None` (JSON column, nullable).
   - Do **not** allow overriding `mode` itself. A user who wants a different
     mode should select a different preset / submit a new practice. Document
     this in the model docstring.

2. **Alembic migration** — additive, no backfill needed.

3. **Resolver** — `backend/src/domain/practice_resolution.py`
   - `def effective_config(practice: Practice, user_practice: UserPractice |
     None) -> ModeConfig`
     - Returns the catalog config when no override is set.
     - When an override is set, validate it against the catalog `mode` via
       the existing discriminated union; raise `ValueError` on mismatch (a
       request handler maps to 400; the seed and migration paths must never
       hit this branch).
   - `def effective_name(...) -> str` — `custom_name or practice.name`.
   - Both helpers are pure functions (no DB access) so they're trivially
     testable.

4. **Schema additions** — `backend/src/schemas/user_practice.py`
   - `UserPracticeCustomize`:
     - `custom_name: str | None = None`
     - `mode_config_override: ModeConfig | None = None`
     - Both nullable so a request can clear an override by passing `null`.
   - `UserPracticeDetail` (response) gains `effective_name: str` and
     `effective_config: ModeConfig` so the frontend doesn't merge on its
     own.

5. **Endpoint** — `backend/src/routers/user_practices.py`
   - `PATCH /user-practices/{id}/customize` with `UserPracticeCustomize`
     body.
   - Reuse the existing `require_owned_user_practice` dependency for
     authorization.
   - Validate `mode_config_override.mode == practice.mode` before commit.
     Return 400 `mode_mismatch` if the client tries to flip the mode.
   - On success, return the updated `UserPracticeDetail`.

6. **Tests** (`backend/tests/test_user_practice_customization.py`)
   - PATCH with `custom_name='My Sit'` updates the name and is reflected on
     subsequent GETs.
   - PATCH with a valid `mode_config_override` returns the override in
     `effective_config`.
   - PATCH with `mode_config_override=null` clears the override (subsequent
     GETs return the catalog config).
   - PATCH with a mismatched mode returns 400 `mode_mismatch`.
   - PATCH on someone else's `UserPractice` returns 403 (existing ownership
     dep).
   - PATCH on a missing id returns 404.
   - Unit test the pure resolver against all 7 modes.

## Acceptance Criteria

- Customization round-trips: PATCH → GET shows the change.
- Catalog `Practice` row is never mutated by user actions.
- `effective_config` is the single source of truth for the UI.
- Coverage targets met; no new suppressions.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/models/user_practice.py` | Modify |
| `backend/alembic/versions/<rev>_user_practice_overrides.py` | **Create** |
| `backend/src/domain/practice_resolution.py` | **Create** |
| `backend/src/schemas/user_practice.py` | Modify |
| `backend/src/routers/user_practices.py` | Modify |
| `backend/tests/test_user_practice_customization.py` | **Create** |
| `backend/tests/test_practice_resolution.py` | **Create** |

## If you blow the budget

Land the model + migration + resolver in one PR (≈250 LoC) and the PATCH
endpoint + integration tests in a second PR (≈250 LoC). Both halves are
useful independently — the resolver is consumed by `ritual-04` analytics
even before the PATCH endpoint ships.
