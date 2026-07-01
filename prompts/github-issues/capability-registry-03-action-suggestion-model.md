# capability-registry-03: Generalize `CompletionSuggestion` → `ActionSuggestion`

**Labels:** `enhancement`, `architecture`, `backend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 01
**Estimated LoC:** ~300

## Role

You are a SQLModel engineer generalizing the suggestion data layer from
"habit/practice completion" to "any capability action," using the generic
addressing `InvitationSignal` already models
(`backend/src/models/invitation_signal.py:73-128`) instead of the per-type FK
columns `CompletionSuggestion` uses today
(`backend/src/models/completion_suggestion.py:78-148`).

## Goal

Introduce `ActionSuggestion`: a journal-anchored proposal that *some capability
verb* applies to a span of an entry, with the same `pending → accepted →
dismissed` lifecycle and character-anchor snapshot, addressed generically by
`(capability_key, target_type, target_id, verb)` plus a JSON `params` payload.
Route the existing completion flow onto it so `CompletionSuggestion` becomes a
read adapter (or is migrated in place) — with the current tests green.

## Context

`CompletionSuggestion` hard-codes two FK columns (`goal_id`, `user_practice_id`)
and a CHECK enforcing exactly one — so every new target type needs a new column.
`InvitationSignal` instead stores `target_type: str` + nullable `target_id: int`
with no per-type FK; that generic shape is what new capabilities need.

## Tasks

1. **New model `backend/src/models/action_suggestion.py`:**
   - `id`, `journal_entry_id` (FK, CASCADE), denormalized `user_id` (FK, CASCADE).
   - `capability_key: str`, `target_type: str`, `target_id: int | None`,
     `verb: str` — generic addressing, no per-type FK. CHECK constraints derived
     from the registry-known key/verb sets are out of scope (keys are open);
     instead validate at the API edge against `REGISTRY`.
   - `params: dict = Field(sa_column=Column(JSON, server_default="{}"))`.
   - `label`, `anchor_start`, `anchor_end`, `anchor_text` (mirror
     `CompletionSuggestion`'s anchor CHECKs: `anchor_start >= 0`,
     `anchor_end > anchor_start`, `anchor_text` ≤ 280).
   - `status` (`pending/accepted/dismissed`), `accepted_at`, `created_at`,
     `updated_at` — reuse `SuggestionStatus`.
   - Indexes on `journal_entry_id`, `user_id`, and `(user_id, status)`.
2. **Migration:** create `actionsuggestion`. **Backfill** existing
   `completionsuggestion` rows into it: `capability_key = target_type`,
   `verb = "complete"`, `target_id` = the goal or user_practice id, preserving
   status/anchors/timestamps. `downgrade()` drops the new table.
3. **Compatibility:** keep `CompletionSuggestion` responses working. Simplest
   path: repoint the journal router's suggestion reads/writes at
   `ActionSuggestion` and have the `CompletionSuggestion*` response schemas
   project from it (habit ⇒ needs `goal_id`, practice ⇒ `user_practice_id`,
   resolved from `target_type`+`target_id`). Existing endpoints and their tests
   stay green.
4. **Tests:** round-trip a non-completion suggestion (e.g. `capability_key="wheel"`,
   `verb="note"`, arbitrary `params`); backfill parity test proving migrated
   completion rows still serialize identically through the legacy response.

## Acceptance Criteria

- [ ] `ActionSuggestion` stores an arbitrary capability action with no schema change per target type.
- [ ] Every existing `CompletionSuggestion` endpoint + test passes unchanged (via projection/backfill).
- [ ] Migration backfills losslessly and rolls back on empty table.
- [ ] Anchor + lifecycle invariants match the `CompletionSuggestion` precedent.
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/models/action_suggestion.py` | **Create** |
| `backend/src/models/__init__.py` | Modify (register table) |
| `backend/src/schemas/action_suggestion.py` | **Create** |
| `backend/migrations/versions/<rev>_action_suggestion.py` | **Create** |
| `backend/src/routers/journal.py` | Modify (read/write via new model) |
| `backend/tests/test_action_suggestion.py` | **Create** |
| `backend/tests/test_journal_suggestions.py` | Modify (parity) |

## Constraints

- Generic addressing only — **no per-type FK columns**. Ownership/existence of
  `target_id` is validated in the accept path (05), not by DB FKs, because
  target tables vary per capability.
- Do not change the `pending → accepted → dismissed` semantics or the anchor
  snapshot contract.
- Keep the denormalized `user_id` so "all proposals for a user" stays a range scan.
