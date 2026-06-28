# Phase 7-05: Complete Stub Implementations

> **Status (2026-06-28): COMPLETE.** All three stubs named below were
> implemented in subsequent work. This file is retained as an audit record;
> verify against `main` before reopening. (The header previously read
> "Phase 6-05" — corrected to Phase 7-05 to match its epic.)

## Problem

Several features shipped as stubs returning hardcoded or zero values. Users saw misleading data.

## Stubs to Complete

### 1. Stage Progress Calculation (`domain/stage_progress.py`) — ✅ DONE

The hardcoded `habits_progress = 0.0`, `course_items = 0`, and `divisor = 2`
are gone. `compute_stage_progress` now derives:

- `habits_progress` from `GoalCompletion` records via `_compute_habits_progress`,
- `course_items` from `ContentCompletion` joined through `StageContent`/`CourseStage`,
- the divisor dynamically via `_average_present` (mean of the components that
  actually have data — habits, practice, course), so a stage with one component
  reports that component directly instead of dividing by a magic 2.

A batched variant (`compute_stage_progress_batch`, three grouped queries) removes
the N+1 on `list_stages` (#473). Covered by `tests/domain/test_stage_progress.py`.

### 2. Energy Plan Persistence (`routers/energy.py`) — ✅ DONE

Plans now persist to the `energyplan` table keyed by `(user, X-Idempotency-Key)`
via `services.energy.get_or_create_persisted_plan`; a keyed retry replays the
stored plan across restarts and workers (no longer an in-memory TTL cache). The
CPU-bound `generate_plan` runs off the event loop (BUG-INFRA-009).

### 3. LLM Error Handling (`services/botmason.py`) — ✅ DONE

Provider calls are wrapped: `_RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}`,
`_is_retryable`, exponential-backoff retry, a 30s timeout (`_LLM_TIMEOUT_SECONDS`,
BUG-JOURNAL-005), and a SDK-agnostic `LLMProviderError` that the journal layer
maps to user-friendly copy rather than a raw 500. (Note: this service now backs
**Resonance** generation, not the removed chat surface.)

## Acceptance Criteria

- [x] Stage progress shows real percentages based on actual user data
- [x] Energy plans persist to database with audit trail
- [x] LLM provider errors produce user-friendly responses (not raw 500)
- [x] All existing tests pass + new tests for each completion

## Estimated Scope
~250 LoC (delivered)
