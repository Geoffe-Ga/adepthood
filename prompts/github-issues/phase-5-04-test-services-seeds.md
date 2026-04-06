# phase-5-04: Add test coverage for BotMason service and seed scripts

**Labels:** `phase-5`, `backend`, `testing`, `priority-high`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~200

## Problem

`services/botmason.py` is at 20% coverage (lines 35–41, 54–59, 78–86, 91,
99–106, 115–124, 133–151 uncovered). The service contains LLM provider
dispatch logic, system prompt loading, and message building — all untested.
`seed_content.py` (24%) and `seed_stages.py` (26%) also lack tests.

## Scope

Write unit tests for the BotMason service (stub, message building, system
prompt resolution) and the seed scripts. Does NOT test actual LLM API calls.

## Tasks

1. **BotMason service tests** (`backend/tests/test_botmason_service.py`)
   - `get_system_prompt()`: default, env var inline, env var file path
   - `_build_messages()`: correct role mapping, system prompt position
   - `_stub_response()`: returns deterministic string
   - `generate_response()` with stub provider
   - `_import_optional()`: raises RuntimeError when module missing

2. **Seed script tests** (`backend/tests/test_seeds.py`)
   - `seed_content.py`: verify content items created for a stage
   - `seed_stages.py`: verify stages seeded with correct metadata
   - Idempotency: running seed twice doesn't duplicate rows

## Acceptance Criteria

- `services/botmason.py` coverage ≥85%
- `seed_content.py` and `seed_stages.py` coverage ≥75%
- No actual LLM API calls made during tests
- Overall backend coverage reaches ≥85%
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/tests/test_botmason_service.py` | **Create** |
| `backend/tests/test_seeds.py` | **Create** |
