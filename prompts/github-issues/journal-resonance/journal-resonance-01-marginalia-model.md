# journal-resonance-01: Marginalia model + migration

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** none
**Estimated LoC:** ~225

## Role

You are a backend engineer adding a new SQLModel table and Alembic migration to
Adepthood, following the patterns already used by `JournalEntry`.

## Goal

Introduce the `Marginalia` table that stores AI margin notes anchored to spans
of a journal page, plus the `MarginaliaKind` and `MarginaliaStatus` enums. This
issue is data-layer only — no endpoints, no LLM.

## Context

- `backend/src/models/journal_entry.py` is the reference: a `SQLModel,
  table=True` with FK to `user`, a `JournalTag` `StrEnum`, soft-delete column,
  and composite indexes. Mirror its conventions (UTC `datetime`, `Field`
  constraints, `Relationship`).
- The full column contract is fixed in the epic
  ([Journal Resonance](journal-resonance-epic.md) → "Canonical contract").
- Alembic setup lives under `backend/alembic/` (see existing migrations for the
  revision style and `op.create_table` / `op.create_index` usage).

## Tasks

1. **Create `backend/src/models/marginalia.py`**
   - `class MarginaliaKind(enum.StrEnum)`: `THEME = "theme"`,
     `CONNECTION = "connection"`, `SYMBOL = "symbol"`.
   - `class MarginaliaStatus(enum.StrEnum)`: `ACTIVE = "active"`,
     `STALE = "stale"`.
   - `class Marginalia(SQLModel, table=True)` with exactly the columns in the
     epic contract (id, journal_entry_id, user_id, kind, anchor_start,
     anchor_end, anchor_text, note, essay, essay_generated_at, status,
     created_at, updated_at).
   - FK `journal_entry_id → journalentry.id` with `ondelete="CASCADE"`;
     FK `user_id → user.id` with `ondelete="CASCADE"`.
   - Index on `journal_entry_id` (notes are always loaded per-page).
   - `created_at` / `updated_at` default to `datetime.now(UTC)`; `updated_at`
     uses `sa_column_kwargs={"onupdate": ...}` per the existing pattern.
2. **Add `EntryStatus` enum** to `backend/src/models/journal_entry.py`
   (`DRAFT = "draft"`, `FINISHED = "finished"`) — the column that uses it lands
   in issue 02, but the enum lives with the entry model and is harmless to add
   now. (If you prefer, defer the enum to 02 and note it here.)
3. **Register the model** wherever models are imported for metadata
   (`backend/src/models/__init__.py` or equivalent) so Alembic autogenerate and
   `SQLModel.metadata.create_all` see it.
4. **Add the relationship** on `JournalEntry`:
   `marginalia: list["Marginalia"] = Relationship(back_populates="entry",
   sa_relationship_kwargs={"cascade": "all, delete-orphan"})`, and the inverse
   `entry: "JournalEntry" = Relationship(back_populates="marginalia")` on
   `Marginalia`.
5. **Write the Alembic migration** `backend/alembic/versions/*_add_marginalia.py`
   — `create_table("marginalia", ...)` with the columns, FKs, and the
   `journal_entry_id` index. Provide a working `downgrade()` that drops them.
6. **Tests** — `backend/tests/test_marginalia_model.py`:
   - Can insert a `Marginalia` row tied to a `JournalEntry` and read it back.
   - Deleting the parent `JournalEntry` cascades and removes its marginalia.
   - `kind` / `status` round-trip as their string values.
   - Enum members expose the expected `.value`s.

## Acceptance Criteria

- [ ] `Marginalia`, `MarginaliaKind`, `MarginaliaStatus` exist and import cleanly.
- [ ] Migration applies and reverts (`alembic upgrade head` / `downgrade -1`).
- [ ] Cascade delete from `JournalEntry` removes marginalia.
- [ ] `./scripts/backend/check-all.sh` green (90% line / 80% branch / 85%
      docstring); no new mypy or ruff findings.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/models/marginalia.py` | **Create** |
| `backend/src/models/journal_entry.py` | Modify (relationship + `EntryStatus`) |
| `backend/src/models/__init__.py` | Modify (register model) |
| `backend/alembic/versions/*_add_marginalia.py` | **Create** |
| `backend/tests/test_marginalia_model.py` | **Create** |

## Constraints

- Match the column names/types in the epic contract exactly — downstream issues
  depend on them.
- No business logic here (no anchor resolution, no LLM). Pure schema + persistence.
- Follow the existing UTC datetime + soft-delete conventions; do not add a
  soft-delete column to marginalia (cascade from the parent entry is enough).
