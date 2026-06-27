# journal-resonance-03: `PATCH /journal/{entry_id}` edit-entry endpoint

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-02](journal-resonance-02-entry-document-fields.md)
**Estimated LoC:** ~175

## Role

You are a backend engineer adding an edit endpoint so a journal **page** can be
revised after it is written (a document, not an immutable chat message).

## Goal

Add `PATCH /journal/{entry_id}` that updates `message` (body), `title`, and/or
`status` of the caller's own entry, refreshes `updated_at`, and returns the
updated entry. Re-anchoring of marginalia on body changes is a separate concern
wired in issue 07 — expose a clean seam for it here.

## Context

- `backend/src/routers/journal.py` already has create/list/get/delete with
  ownership filtering (`user_id == current_user.id`, `deleted_at IS NULL`) and
  `sanitize_user_text()` on inbound text.
- `backend/src/schemas/journal.py` holds the DTOs.

## Tasks

1. **Schema** — `JournalEntryUpdate` in `schemas/journal.py`:
   - `message: str | None` (min 1, max 10_000 when present),
     `title: str | None`, `status: EntryStatus | None`. All optional;
     at least one must be provided (validate → 422 if the body is empty).
2. **Endpoint** — `async def update_journal_entry(entry_id, payload, ...)`:
   - Load the caller's non-deleted entry or `404 journal_entry_not_found`.
   - Sanitize `message`/`title` with `sanitize_user_text()` when present.
   - Apply provided fields; set `updated_at = now()`.
   - **Seam for issue 07:** if `message` changed, call a
     `reanchor_entry_marginalia(entry, old_body, new_body, session)` hook. In
     this issue, define the hook as a no-op stub (or import the real one if 07
     landed first) so the wiring exists and 07 only fills in the body.
   - Commit and return `JournalMessageResponse`.
3. **Tests** — `backend/tests/test_journal_patch.py`:
   - Patch body → 200, body updated, `updated_at` advanced.
   - Patch `title` only / `status` only → 200, other fields untouched.
   - Empty payload → 422.
   - Patching another user's entry → 404 (no enumeration).
   - Patching a soft-deleted entry → 404.
   - Body sanitized (control chars stripped) on update.

## Acceptance Criteria

- [ ] `PATCH /journal/{id}` updates body/title/status with ownership + soft-delete
      checks identical to the other journal routes.
- [ ] `updated_at` advances; `JournalMessageResponse` returned.
- [ ] A re-anchor hook is invoked when (and only when) the body changes.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` | Modify |
| `backend/src/schemas/journal.py` | Modify |
| `backend/tests/test_journal_patch.py` | **Create** |

## Constraints

- Mirror the existing ownership/soft-delete/sanitization patterns exactly.
- Do not implement the re-anchoring algorithm here — only the call seam. Keep the
  stub trivial and well-documented so issue 07 is a drop-in.
