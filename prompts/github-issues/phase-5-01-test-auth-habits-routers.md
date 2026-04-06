# phase-5-01: Add test coverage for auth and habits routers

**Labels:** `phase-5`, `backend`, `testing`, `priority-critical`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~300

## Problem

Backend test coverage is 52.9%, far below the 90% threshold enforced by
pre-commit and CI. The `routers/auth.py` and `routers/habits.py` modules are
among the most critical paths in the application but have significant untested
code. `routers/habits.py` is at 37% coverage with lines 30–34, 43–50, 60–67,
78–86, 96–101, 108–117, 127–129 uncovered. The auth router handles signup,
login, lockout, and JWT token creation — all security-critical flows.

## Scope

Write integration tests for all endpoints in `routers/auth.py` and
`routers/habits.py`. Does NOT include refactoring the routers themselves.

## Tasks

1. **Auth router tests** (`backend/tests/test_auth.py`)
   - Test signup: success, duplicate email, password too short
   - Test login: success, wrong password, non-existent user
   - Test account lockout after MAX_FAILED_ATTEMPTS consecutive failures
   - Test lockout expiry after LOCKOUT_DURATION
   - Test `get_current_user`: valid token, expired token, missing token, malformed token
   - Test rate limiting returns 429

2. **Habits router tests** (`backend/tests/test_habits.py`)
   - Test CRUD: create, list, get, update, delete
   - Test ownership scoping: user A cannot see/modify user B's habits
   - Test 404 on non-existent habit
   - Test `GET /{habit_id}/stats` returns computed stats
   - Test list returns habits with eager-loaded goals

## Acceptance Criteria

- All auth and habits router endpoints have at least one happy-path and one error-path test
- `pytest --cov=src/routers/auth --cov=src/routers/habits` shows ≥85% for both modules
- No existing tests break
- Tests use `async_client` and `db_session` fixtures from `conftest.py`

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/tests/test_auth.py` | **Create** |
| `backend/tests/test_habits.py` | **Create** |
| `backend/conftest.py` | Modify (add auth helper fixtures if needed) |
