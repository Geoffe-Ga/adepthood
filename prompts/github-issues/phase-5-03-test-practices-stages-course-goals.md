# phase-5-03: Add test coverage for practices, stages, course, and goal routers

**Labels:** `phase-5`, `backend`, `testing`, `priority-critical`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~300

## Problem

Multiple routers have low coverage:
- `routers/practices.py` — 53% (lines 25–31, 41–45, 55–63)
- `routers/stages.py` — 35% (lines 38–44, 71–79, 103–107, 117–145)
- `routers/practice_sessions.py` — 43% (lines 28–46, 56–62, 71–80)
- `routers/user_practices.py` — 40% (lines 35–51, 60–61, 71–85)
- `routers/goal_completions.py` — coverage unknown but streak/milestone logic
  is untested at the integration level
- `routers/goal_groups.py` — 27% (lines 42–53, 62–71, 81–90, 100–111, 122–134, 144–157)
- `routers/course.py` — coverage unknown but drip-feed logic is untested

## Scope

Write integration tests for these six router modules. Focus on endpoint
behavior, not domain logic (domain functions already have unit tests).

## Tasks

1. **Practices + user-practices + sessions** (`backend/tests/test_practices.py`)
   - List approved practices for a stage
   - Get single practice by id, 404 on missing
   - Submit new practice (defaults to unapproved)
   - Create user-practice selection, list selections
   - Get user-practice detail with session history
   - Create practice session, verify ownership check
   - Week count endpoint returns correct count

2. **Stages** (`backend/tests/test_stages.py`)
   - List stages with progress overlay
   - Get single stage, 404 on missing
   - Get stage progress breakdown
   - Update progress (advance forward), reject backwards

3. **Course** (`backend/tests/test_course.py`)
   - List stage content with drip-feed gating
   - Get single content item
   - Mark content as read (idempotent)
   - Course progress endpoint

4. **Goal completions + goal groups** (`backend/tests/test_goals.py`)
   - Create goal completion, verify streak calculation
   - Ownership check through parent habit
   - Goal group CRUD: create, list, get, update, delete
   - Seed templates created on first list
   - Shared template visibility

## Acceptance Criteria

- All endpoints in these six routers have at least one test
- Coverage for each module ≥80%
- Overall backend coverage crosses 75%+
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/tests/test_practices.py` | **Create** |
| `backend/tests/test_stages.py` | **Create** |
| `backend/tests/test_course.py` | **Create** |
| `backend/tests/test_goals.py` | **Create** |
