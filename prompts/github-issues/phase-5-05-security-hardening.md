# phase-5-05: Fix LIKE injection, bot-response authz, and energy auth gaps

**Labels:** `phase-5`, `backend`, `security`, `priority-high`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~175

## Problem

Three security issues found during triage:

1. **Journal search LIKE injection** (`routers/journal.py:63`): The search query
   is interpolated into `ilike(f"%{filters.search}%")` without escaping SQL
   wildcards (`%`, `_`). A user can craft search terms like `%` to match all
   entries or `_` to perform single-character wildcards, bypassing intended
   search behavior. Current state: `col(JournalEntry.message).ilike(f"%{filters.search}%")`.

2. **Bot-response endpoint missing ownership check** (`routers/journal.py:133–143`):
   The `create_bot_response` endpoint accepts a `user_id` in the payload body
   (`JournalBotMessageCreate`) but only checks that the caller is authenticated
   (`_current_user`), not that they're creating a response for themselves. A
   user could create bot responses attributed to another user.

3. **Energy endpoint has no authentication** (`routers/energy.py:42–55`): The
   `create_plan` endpoint doesn't use `get_current_user` dependency, making it
   publicly accessible. While it doesn't access user data, it exposes server
   compute resources to unauthenticated abuse.

## Scope

Fix all three security issues with tests. Does NOT include broader auth
refactoring or rate-limit changes.

## Tasks

1. **Escape LIKE wildcards in journal search**
   - Create a `_escape_like(value: str) -> str` helper that escapes `%`, `_`,
     and `\` characters
   - Apply to the search filter in `_build_filter_conditions`
   - Add tests verifying wildcards are escaped

2. **Enforce ownership in bot-response endpoint**
   - Change `_current_user` to `current_user` and set `user_id=current_user`
     on the created entry, ignoring any user_id from the payload
   - Add test: authenticated user can only create bot responses for themselves

3. **Add auth to energy endpoint**
   - Add `current_user: int = Depends(get_current_user)` to `create_plan`
   - Update test to include auth token
   - Add test: unauthenticated request returns 401

## Acceptance Criteria

- Journal search with `%` or `_` in query treats them as literal characters
- Bot-response endpoint always uses the authenticated user's ID
- Energy endpoint returns 401 without valid JWT
- All three fixes have regression tests
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` | Modify |
| `backend/src/routers/energy.py` | Modify |
| `backend/tests/test_journal.py` | Modify (add LIKE escape tests) |
| `backend/tests/test_energy.py` | Modify (add auth tests) |
