# phase-5-02: Add test coverage for journal, botmason, and prompts routers

**Labels:** `phase-5`, `backend`, `testing`, `priority-critical`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~300

## Problem

`routers/journal.py` is at 39% coverage (lines 52–56, 61–68, 78–93, 107–110,
120–125, 139–143 uncovered). `routers/prompts.py` is at 35% (lines 34–49,
58–72, 96–109, 132–144, 165–200 uncovered). `routers/botmason.py` coverage is
not shown but the BotMason chat flow — which deducts offering_balance, stores
entries, and calls AI — has zero integration tests.

## Scope

Write integration tests for all endpoints in `routers/journal.py`,
`routers/botmason.py`, and `routers/prompts.py`. Uses stub BotMason provider.

## Tasks

1. **Journal router tests** (`backend/tests/test_journal.py`)
   - Test create entry (201), list with pagination, get by id, delete (204)
   - Test search filter (`?search=keyword`) returns matching entries
   - Test tag filter (`?tag=stage_reflection`) works correctly
   - Test invalid tag returns 400
   - Test practice_session_id filter
   - Test ownership scoping (user cannot read/delete another user's entry)
   - Test bot-response endpoint creates bot sender entry

2. **BotMason router tests** (`backend/tests/test_botmason.py`)
   - Test `/journal/chat`: stores user message, generates response, deducts balance
   - Test insufficient balance returns 402
   - Test `/user/balance` returns current balance
   - Test `/user/balance/add` with positive amount, reject zero/negative

3. **Prompts router tests** (`backend/tests/test_prompts.py`)
   - Test `/prompts/current` returns the right week's prompt
   - Test `POST /prompts/{week}/respond` creates response + journal entry
   - Test duplicate response returns 400
   - Test `/prompts/history` returns paginated responses

## Acceptance Criteria

- All journal, botmason, and prompts endpoints have happy-path and error-path tests
- `pytest --cov` for these three modules shows ≥85%
- Tests use stub BotMason provider (no external API calls)
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/tests/test_journal.py` | **Create** |
| `backend/tests/test_botmason.py` | **Create** |
| `backend/tests/test_prompts.py` | **Create** |
