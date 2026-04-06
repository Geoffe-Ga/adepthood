# phase-5-07: Move seed template creation to app startup

**Labels:** `phase-5`, `backend`, `performance`, `priority-medium`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~125

## Problem

`routers/goal_groups.py:62–63` calls `ensure_seed_templates(session)` on every
`GET /goal-groups/` request. This executes a database query to check for
existing built-in templates and potentially inserts new rows — on every single
list call. For an endpoint that may be called frequently (e.g., on habit screen
load), this is unnecessary overhead after the first invocation.

Current state:
```python
async def list_goal_groups(...):
    await ensure_seed_templates(session)  # runs every time
    ...
```

## Scope

Move seed template creation to the application lifespan startup event. Does NOT
change the seed template content or goal group API behavior.

## Tasks

1. **Move `ensure_seed_templates` to lifespan**
   - In `main.py`, call `ensure_seed_templates` during the `lifespan` startup
     phase, using a fresh session from the factory
   - Remove the `ensure_seed_templates` call from the `list_goal_groups` endpoint

2. **Update tests**
   - Ensure test fixtures seed templates in setup if tests rely on them
   - Add a test verifying templates exist after app startup
   - Verify `GET /goal-groups/` works without calling `ensure_seed_templates`

3. **Add a `seed_templates` CLI entry point** (optional)
   - Create a small script `backend/src/seed_templates.py` that can be run
     independently for deployment scenarios

## Acceptance Criteria

- `ensure_seed_templates` runs exactly once at startup, not per-request
- `GET /goal-groups/` returns the same results as before
- Templates are present in the database after app boot
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/main.py` | Modify (add to lifespan) |
| `backend/src/routers/goal_groups.py` | Modify (remove per-request call) |
| `backend/tests/test_goals.py` | Modify (fixture setup) |
