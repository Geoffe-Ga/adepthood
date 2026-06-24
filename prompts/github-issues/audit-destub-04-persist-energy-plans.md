# audit-destub-04: Persist energy plans to a table

**Labels:** `audit-destub`, `backend`, `persistence`, `priority-high`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~380  (hard cap 700)

## Problem
`backend/src/services/energy.py:32-76` keeps every generated plan **only** in a module-level
`TTLCache(maxsize=1000, ttl=3600)`. Plans are lost on process restart, and the cache is per-process:
under multiple workers the same `idempotency_key` yields **different** plans on different workers
(the same horizontal-scaling defect already noted for `_IDEMPOTENCY_STORE` in
`practice_sessions.py`). There is no durable record of what plan a user was given.
**Current state:** §5.1 class **fake** / per-process cache (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md`
§6, row 4; §3 `services/energy.py:32-34`). The energy plan is **supposed to be real for ship**, so
it needs durable, cross-worker storage. Supersedes the energy-persistence item in
`phase-7-05-complete-stubs.md`.

## Scope
**Covers:** a new `EnergyPlan` table, a reversible Alembic migration, and persistence of generated
plans keyed by `(user_id, idempotency_key)` so a retry returns the stored plan verbatim across
restarts and workers. **Does NOT cover:** server-side cost loading (that is `audit-destub-03`, a
prerequisite — land it first so persisted plans store trusted inputs) or a plan-history list
endpoint (file separately if wanted).

## Tasks
1. **Model** — add `backend/src/models/energy_plan.py` with `EnergyPlan(SQLModel, table=True)`:
   `id`, `user_id` (FK, `ondelete="CASCADE"`), `idempotency_key` (nullable), the serialized plan
   payload + `reason_code`, and `created_at`. Add a UNIQUE constraint on
   `(user_id, idempotency_key)` for keyed requests (partial/where-key-not-null to match the
   prod/SQLite index mirror convention in `conftest.py`).
2. **Migration** — generate a reversible Alembic migration creating the table + index. `upgrade`
   creates; `downgrade` drops. No `ALTER`/`DROP` against existing tables; this is purely additive.
   Pass `alembic check` (model ↔ migration agreement).
3. **Persist + read-through** — rewrite `get_or_generate_plan` so a keyed request first looks up a
   persisted `EnergyPlan` for `(user_id, idempotency_key)`; on miss it generates, persists, and
   returns. Replace (or front) the `TTLCache` with the DB lookup. TDD: a test that two calls with
   the same key return the same plan across a simulated restart (fresh service state / cleared
   in-memory cache), and that distinct keys produce distinct rows.
4. **Conftest mirror** — mirror the new UNIQUE index in the SQLite test schema if `conftest.py`
   maintains explicit index mirrors, so the IntegrityError path is exercised.

## Acceptance Criteria
- [ ] An `EnergyPlan` row is written for every generated plan; a keyed retry returns the persisted
      plan, not a freshly-generated one.
- [ ] The same `(user_id, idempotency_key)` returns an identical plan after in-memory state is
      cleared (cross-restart / cross-worker semantics).
- [ ] For migrations: reversible (`downgrade` drops the table cleanly); no destructive op on live
      data; `alembic check` passes.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/models/energy_plan.py` | Create (`EnergyPlan` table) |
| `backend/alembic/versions/<rev>_add_energy_plan.py` | Create (reversible migration) |
| `backend/src/services/energy.py` | Modify (DB persist + read-through) |
| `backend/src/routers/energy.py` | Modify (thread session to service) |
| `backend/conftest.py` | Modify (mirror UNIQUE index if applicable) |
| `backend/tests/services/test_energy.py` | Modify (persistence + cross-restart tests) |
