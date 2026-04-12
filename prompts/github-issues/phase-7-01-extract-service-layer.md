# Phase 6-01: Extract Backend Service Layer

## Problem

Business logic is embedded directly in router files. Metering (wallet reset, spend, balance check), streak calculation, stage progress computation, and LLM orchestration all live alongside HTTP handling code. This makes the logic impossible to reuse, hard to unit test, and violates single responsibility.

## Key Violations

- `routers/botmason.py:105-303` — wallet reset, spend, usage logging are all router helpers
- `routers/goal_completions.py:32-89` — streak computation mixed with HTTP handling
- `domain/stage_progress.py:40-75` — only partially extracted; still called directly from routers with raw session
- `routers/energy.py:42-55` — plan generation + in-memory caching in the router

## What to Extract

### `services/wallet.py`
- `reset_monthly_usage_if_due(session, user) -> bool`
- `spend_one_message(session, user_id) -> SpendResult`
- `add_balance(session, user_id, amount) -> int`

### `services/streaks.py`
- `compute_consecutive_streak(session, goal_id, user_id) -> int`
- `update_streak(current, did_complete) -> tuple[int, str]`
- `check_milestones(streak, thresholds) -> list[Milestone]`

### `services/energy.py`
- `generate_energy_plan(payload) -> EnergyPlanResponse`
- Idempotency caching stays here (not in router)

## Acceptance Criteria

- [ ] Each router file is <150 lines (HTTP handling only)
- [ ] Business logic callable without HTTP context (for testing, background jobs)
- [ ] Existing tests pass without modification (behavior unchanged)
- [ ] New unit tests for extracted services (no HTTP fixtures needed)

## Estimated Scope
~400 LoC (move + refactor, net change is small)
