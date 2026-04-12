# Phase 6-05: Complete Stub Implementations

## Problem

Several features shipped as stubs returning hardcoded or zero values. Users see misleading data.

## Stubs to Complete

### 1. Stage Progress Calculation (`domain/stage_progress.py:40-75`)

```python
habits_progress = 0.0  # HARDCODED
course_items = 0        # HARDCODED
divisor = 2             # HARDCODED
```

**Fix**: Actually compute habits_progress from goal completion data. Compute course_items from ContentCompletion records. Calculate divisor dynamically based on which components have data.

### 2. Energy Plan Persistence (`routers/energy.py:42-55`)

Plans are generated but never stored. The in-memory TTL cache (1 hour) is the only record. In horizontally-scaled deployments, cache isn't shared.

**Fix**: Store energy plans in a new `EnergyPlan` table. Use the plan ID for idempotency instead of an in-memory cache.

### 3. LLM Error Handling (`services/botmason.py:290-314`)

OpenAI/Anthropic calls have no error handling. Provider failures (429, 401, 503) return raw 500 to user.

**Fix**: Wrap provider calls in try/except. Map provider errors to user-friendly responses:
- 429 → "BotMason is busy, try again in a moment"
- 401 → "Your API key is invalid" (if BYOK) or "Service configuration error" (server key)
- 503/timeout → "BotMason is temporarily unavailable"

## Acceptance Criteria

- [ ] Stage progress shows real percentages based on actual user data
- [ ] Energy plans persist to database with audit trail
- [ ] LLM provider errors produce user-friendly 502/503 responses (not raw 500)
- [ ] All existing tests pass + new tests for each completion

## Estimated Scope
~250 LoC
