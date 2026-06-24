# audit-async-03: Add a composite index to JournalEntry for the chat read path

**Labels:** `audit-async`, `backend`, `performance`, `priority-high`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~150  (hard cap 700)

## Problem
`load_recent_conversation` filters `JournalEntry` on `(user_id, sender,
deleted_at)` and orders by `id DESC`, but the only index on the table is the
single-column `ix_journalentry_deleted_at`. Every chat turn therefore scans the
user's full journal history (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:53`; §5.3
missing composite index).
**Current state:** `models/journal_entry.py:50-62` declares only
`Index("ix_journalentry_deleted_at", "deleted_at")` in `__table_args__`.

## Scope
Covers adding one composite index supporting the `(user_id, sender, deleted_at)`
filter with descending-`id` ordering, declared on the model plus a reversible
Alembic migration. Does NOT remove the existing `ix_journalentry_deleted_at`
index, change the soft-delete contract, or alter `load_recent_conversation`'s
query text.

## Tasks
1. **Add a failing model/index test** — in `tests/models/` assert the
   `JournalEntry` table metadata contains a composite index covering
   `("user_id", "sender", "deleted_at")`. Write it first; watch it fail.
2. **Declare the index on the model** — extend the `__table_args__` tuple at
   `models/journal_entry.py:52-55` with
   `Index("ix_journalentry_user_sender_deleted", "user_id", "sender",
   "deleted_at")`, keeping the existing comment+declaration convention so
   `alembic check` agrees.
3. **Generate a reversible migration** — add an Alembic revision whose
   `upgrade()` calls `op.create_index(...)` and whose `downgrade()` calls
   `op.drop_index(...)`. Fully reversible; no destructive op.
4. **Update conftest index mirror** — reflect the new index in the SQLite test
   mirror in `conftest.py` if it maintains an explicit list
   (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:158`).

## Acceptance Criteria
- [ ] `JournalEntry.__table__.indexes` contains a composite index over
      `(user_id, sender, deleted_at)`, and the original `deleted_at` index is
      retained.
- [ ] The Alembic migration `upgrade()` creates and `downgrade()` drops the new
      index; `alembic upgrade head` then `alembic downgrade -1` round-trips with
      no destructive op.
- [ ] `alembic check` reports no model/migration drift.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/models/journal_entry.py` | Modify |
| `backend/migrations/versions/<rev>_add_journalentry_composite_index.py` | Create |
| `backend/tests/models/test_journal_entry_index.py` | Create |
