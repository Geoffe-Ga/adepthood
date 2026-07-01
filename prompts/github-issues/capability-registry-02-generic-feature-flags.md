# capability-registry-02: Generic feature-flag opt-in (retire boolean-per-ring)

**Labels:** `enhancement`, `architecture`, `backend`, `frontend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 01
**Estimated LoC:** ~250

## Role

You are a full-stack engineer removing the single biggest blocker to
pluggability: today every opt-in ring is its own boolean column
(`enable_habits`, `enable_practices`, `enable_course`, `enable_sangha` —
`backend/src/models/user_depth_preferences.py:30-49`), so a new feature needs a
migration and edits in four correlated frontend spots
(`frontend/src/store/useDepthPreferencesStore.ts:35-116`).

## Goal

Introduce a **generic** opt-in mechanism keyed by capability `feature_flag`, so
turning a new feature on/off requires no schema change. Preserve the "all on by
default, opt *out* never in" semantics from NORTH-STAR. Keep the four existing
flags working through one release via an adapter (do not break the API shape the
frontend reads today).

## Context

`UserDepthPreferences` is one row per user with four booleans, all defaulting to
enabled. The frontend mirrors them as named selectors. The registry (01) now
knows the full set of flags, so the source of truth for "which flags exist"
moves to the registry; the DB only needs to store the user's *opt-outs*.

## Tasks

1. **Model:** add `disabled_features: list[str]` to `UserDepthPreferences`
   stored as a JSON/`ARRAY(String)` column (`server_default` empty). Keep the
   four boolean columns for now (non-breaking).
2. **Domain (`backend/src/domain/depth_preferences.py`):** a resolver
   `is_enabled(prefs, flag) -> bool` = `flag not in disabled_features`. Provide a
   compatibility layer that derives the four legacy booleans from
   `disabled_features` on read and folds legacy boolean writes into the set, so
   the existing `GET/PATCH /depth-preferences` response keeps its current shape
   (guarded by the existing router tests).
3. **Migration:** add the column; backfill `disabled_features` from any legacy
   row where a boolean is `False`. `downgrade()` reverses.
4. **Frontend:** extend `useDepthPreferencesStore` with a generic
   `isEnabled(flag: string)` selector reading the same server state; keep the
   four named selectors as thin wrappers over it (no consumer churn).
5. **Tests:** round-trip; legacy boolean read/write parity; a *new* flag with no
   column (e.g. `"wheel"`) can be disabled and reflected without any migration.

## Acceptance Criteria

- [ ] A capability flag the DB has never heard of can be toggled off and honoured, with **no new column**.
- [ ] Existing `GET/PATCH /depth-preferences` response shape and router tests unchanged.
- [ ] Default remains fully opted-in; disabling is additive to `disabled_features`.
- [ ] Migration backfills legacy `False` flags; round-trips on fresh + populated DB.
- [ ] `pytest backend/` + `cd frontend && npm test` + `pre-commit run --all-files` green.

## Files

| File | Action |
|------|--------|
| `backend/src/models/user_depth_preferences.py` | Modify |
| `backend/src/domain/depth_preferences.py` | Modify |
| `backend/src/schemas/depth_preferences.py` | Modify |
| `backend/migrations/versions/<rev>_generic_disabled_features.py` | **Create** |
| `frontend/src/store/useDepthPreferencesStore.ts` | Modify |
| `backend/tests/test_depth_preferences.py` | Modify |
| `frontend/src/store/__tests__/useDepthPreferencesStore.test.ts` | Modify |

## Constraints

- Non-breaking: the four boolean columns stay this release; a follow-up drops
  them once nothing reads them (tracked as an epic open question).
- The registry (01) is the source of truth for the set of valid flags; the DB
  stores only opt-outs. An unknown flag defaults to enabled, never errors.
- Honour the invitation/quiet ethos: disabling a ring must never be framed as
  failure anywhere this touches copy.
