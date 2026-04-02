# phase-1-06: Migrate energy router idempotency cache to bounded TTL cache

**Labels:** `phase-1`, `backend`, `priority-high`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-01
**Estimated LoC:** ~80–120

## Problem

`backend/src/routers/energy.py` has an in-memory idempotency cache that grows without bound:

```python
_idempotency_cache: dict[str, EnergyPlanResponse] = {}
```

Every unique `X-Idempotency-Key` header adds an entry. Nothing ever removes entries. Over time this is a memory leak that will eventually crash the server. The cache also vanishes on restart, defeating idempotency across deploys.

The energy router is otherwise the best-structured router in the codebase — it correctly delegates to domain logic, logs with reason codes, and returns structured responses.

## Scope

Replace the unbounded dict with a TTL-bounded cache. Optionally persist idempotency keys to the database for cross-restart durability.

## Tasks

1. **Option A (Simple): Use `cachetools.TTLCache`**
   - `from cachetools import TTLCache`
   - `_idempotency_cache = TTLCache(maxsize=1000, ttl=3600)` — 1 hour, 1000 entries max
   - Add `cachetools` to `requirements.txt`
   - Keeps the same in-memory pattern but prevents unbounded growth

2. **Option B (Durable): Store in DB**
   - Create an `IdempotencyRecord` model with `key`, `response_json`, `created_at`
   - Query before processing, store after
   - Clean up records older than TTL via a periodic task or on read

3. **Recommendation: Option A for now** — it's a 10-line change and solves the memory leak. Option B can be a follow-up if cross-restart idempotency is needed.

4. **Add a test for cache expiry behavior**

## Acceptance Criteria

- Idempotency cache has a maximum size and TTL
- Duplicate requests within TTL return cached response
- Memory usage is bounded
- Existing energy API tests pass

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/energy.py` | Modify (replace dict with TTLCache) |
| `backend/requirements.txt` | Modify (add cachetools) |
| `backend/tests/test_energy_api.py` | Add TTL/eviction test |
