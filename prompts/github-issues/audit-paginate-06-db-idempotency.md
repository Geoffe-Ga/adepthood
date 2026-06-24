# audit-paginate-06: DB-backed practice-session idempotency

**Labels:** `audit-paginate`, `backend`, `contracts`, `priority-high`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~340  (hard cap 700)

## Problem

Practice-session idempotency is held in a module-level in-process dict,
`_IDEMPOTENCY_STORE: dict[str, int]` (`routers/practice_sessions.py:185-218`, with companion
`_IDEMPOTENCY_LOCKS` / `_acquire_idem_lock`). It maps `cache_key → session_id` only for the lifetime of
one process, so the dedup guarantee dies on restart and — critically — **does not hold across workers**:
in any multi-worker deployment two requests carrying the same `Idempotency-Key` can land on different
workers, miss each other's in-memory entry, and both insert a fresh `PracticeSession` — a **duplicate
session**. Current state: this is an §5.3 **response-contract** finding (§4, "in-process idempotency",
High). The codebase already has the correct pattern for this: `services/chat_idempotency.py` backs the
chat dedup with the `ChatSpend` table (atomic SAVEPOINT insert, `UNIQUE(user_id, idem_key)`,
TTL-evicted in-flight tombstones).

## Scope

**Covers:** replacing the in-process dict (and the per-key `asyncio.Lock` machinery that only papers
over the single-process case) with a DB-backed idempotency store modelled on
`services/chat_idempotency.py` — a new table keyed on `UNIQUE(user_id, idem_key)` recording the
deduplicated `session_id`, with a hashed key column (never store the raw header) and a reversible
Alembic migration. The check-then-insert critical section becomes a DB `UNIQUE`-constraint race the
database serialises, so it is correct across workers without process-local locks.

**Does NOT cover:** changing the `Idempotency-Key` header contract or the response shape, reworking
`chat_idempotency.py` itself, or the pagination issues (01–05).

> **NOTE — migration required.** This issue adds a new table, so it needs a **reversible Alembic
> migration** with a working `downgrade()`. Migrations live in `backend/migrations/versions/`; follow
> the existing revision style. The new SQLModel must match the migration's column types exactly (see the
> `ChatSpend` model/migration alignment note at `models/chat_spend.py:52-57`) or `alembic check` /
> `migration-drift` CI flags a spurious diff. Mirror any prod partial/functional index into the
> conftest SQLite schema so the IntegrityError path is exercised (per audit §10).

## Tasks

1. **Add the model + migration** — create `backend/src/models/practice_session_idempotency.py`
   (e.g. `PracticeSessionSpend`) with `id`, `user_id` (FK, `ondelete="CASCADE"`), a hashed `idem_key`
   column (`String`, indexed), the recorded `session_id`, and `created_at`, plus
   `UniqueConstraint("user_id", "idem_key")` — modelled on `models/chat_spend.py`. Add a reversible
   Alembic migration in `backend/migrations/versions/` (`upgrade` creates the table + unique index;
   `downgrade` drops them). Run `alembic check` to confirm no drift.
2. **Add a DB idempotency service** — create `backend/src/services/practice_session_idempotency.py`
   with `hash_idem_key`, a check primitive returning the cached `session_id` (or `None`), and an
   atomic insert primitive using `begin_nested()` (SAVEPOINT) that returns `False` on collision —
   mirroring `check_idempotency` / `insert_idem_tombstone` in `services/chat_idempotency.py`. Decide
   and document whether an in-flight TTL eviction is needed (practice-session writes are fast and
   synchronous, unlike LLM calls — likely no tombstone window, just a recorded `session_id`).
3. **Rewire the router** — in `routers/practice_sessions.py`, replace `_IDEMPOTENCY_STORE`,
   `_IDEMPOTENCY_LOCKS`, `_IDEMPOTENCY_LOCKS_GUARD`, `_acquire_idem_lock`,
   `_lookup_idempotent_session`, and `_remember_idempotent_session` (lines 185-245 region) with calls
   into the new service. The check-then-insert in `_perform_create_session` now relies on the DB
   `UNIQUE` constraint for cross-worker serialisation; remove the process-local `asyncio.Lock` wrapping
   once the DB path is authoritative.
4. **Tests** — same key returns the same `session_id` and inserts exactly one `PracticeSession`
   (existing guarantee preserved); a concurrent/duplicate insert is serialised by the constraint, not a
   lock; the mapping **survives a simulated process restart** (clear in-memory state, replay the key,
   assert no duplicate) — the regression that motivates this issue; and the migration round-trips
   (`upgrade` then `downgrade`) cleanly.

## Acceptance Criteria

- [ ] Practice-session idempotency is backed by a DB table (`UNIQUE(user_id, idem_key)`, hashed key),
      not a module-level dict; the in-process `_IDEMPOTENCY_STORE` / lock machinery is removed.
- [ ] A replay with the same `Idempotency-Key` returns the same `session_id` and creates **exactly one**
      `PracticeSession`, including after a simulated process restart and across workers (constraint, not
      a process-local lock, provides serialisation).
- [ ] The raw `Idempotency-Key` is never persisted (stored as a SHA-256 digest, per the `ChatSpend`
      pattern).
- [ ] A reversible Alembic migration creates and drops the table; `alembic check` / `migration-drift`
      pass with no spurious model↔migration diff; the conftest SQLite schema mirrors any prod index.
- [ ] Existing idempotency behaviour and the `POST /practice-sessions` response shape are unchanged
      (backward compatible).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/models/practice_session_idempotency.py` | **Create** (model modelled on `ChatSpend`) |
| `backend/migrations/versions/<rev>_add_practice_session_idempotency.py` | **Create** (reversible up/down) |
| `backend/src/services/practice_session_idempotency.py` | **Create** (hash + check + atomic insert) |
| `backend/src/routers/practice_sessions.py` | Modify (remove in-process store/locks; call the service) |
| `backend/conftest.py` | Modify (mirror prod index into SQLite test schema if any) |
| `backend/tests/test_practice_sessions.py` | Modify (cross-restart dedup + single-session regression) |
| `backend/tests/test_practice_session_idempotency.py` | **Create** (service-level + migration round-trip) |
