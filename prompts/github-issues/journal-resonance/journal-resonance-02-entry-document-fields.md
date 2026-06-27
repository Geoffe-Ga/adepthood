# journal-resonance-02: JournalEntry document fields (title, status, updated_at)

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** none
**Estimated LoC:** ~175

## Role

You are a backend engineer evolving `JournalEntry` from a discrete chat message
into a long-form **page** (document) the user writes in.

## Goal

Add `title`, `status` (`draft`/`finished`), and `updated_at` to `JournalEntry`,
with a migration that backfills existing rows. Expose the new fields in the
journal response schema. The body stays in the existing `message` column.

## Context

- `backend/src/models/journal_entry.py` — `JournalEntry` SQLModel.
- `backend/src/schemas/journal.py` — `JournalMessageResponse` (omits `user_id`
  by design, per BUG-JOURNAL-004) and `JournalListResponse`.
- `EntryStatus` enum (`draft`/`finished`) — add here if not already added in
  issue 01.

## Tasks

1. **Model fields** on `JournalEntry`:
   - `title: str | None = Field(default=None, max_length=200)`
   - `status: str = Field(default=EntryStatus.DRAFT, max_length=20)`
   - `updated_at: datetime` defaulting to `datetime.now(UTC)` with
     `onupdate` set to now (mirror the `created_at`/`timestamp` pattern).
2. **Migration** `backend/alembic/versions/*_journalentry_document_fields.py`:
   - Add the three columns (nullable where appropriate).
   - **Backfill**: set `status = 'finished'` and `updated_at = timestamp` for all
     existing rows (they are historical entries, not live drafts).
   - Working `downgrade()` dropping the columns.
3. **Schema** — extend `JournalMessageResponse` with `title: str | None`,
   `status: str`, `updated_at: datetime`. Keep omitting `user_id`.
4. **Read paths** — make sure the create/list/get handlers populate the new
   fields. New entries created via `POST /journal` default to `status="draft"`.
5. **Tests** — `backend/tests/test_journal_entry_document_fields.py`:
   - New entry defaults to `status="draft"`, `title=None`, `updated_at` set.
   - Response serializes `title`/`status`/`updated_at` and still omits `user_id`.
   - Migration backfill: a row created before the migration reads back as
     `finished` (assert via a seeded row + applying logic, or a direct model test).

## Acceptance Criteria

- [ ] `JournalEntry` has `title`, `status`, `updated_at`; migration up/down works.
- [ ] Existing rows backfill to `status="finished"`.
- [ ] `JournalMessageResponse` returns the new fields and still hides `user_id`.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/models/journal_entry.py` | Modify |
| `backend/alembic/versions/*_journalentry_document_fields.py` | **Create** |
| `backend/src/schemas/journal.py` | Modify |
| `backend/src/routers/journal.py` | Modify (populate fields on read) |
| `backend/tests/test_journal_entry_document_fields.py` | **Create** |

## Constraints

- Do not rename `message`; it remains the page body.
- `status` is a plain string column constrained by `EntryStatus`; don't add a DB
  CHECK unless the codebase already does so for other enum columns.
- Editing the body/title (the `PATCH` endpoint) is issue 03 — not here.
