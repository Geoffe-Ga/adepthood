# habit-resonance-01: `CompletionSuggestion` model + migration

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** — · **Scope:** Backend · **Est. LoC:** ~200

## Problem

Completion suggestions need a home that is anchored to a journal span like
marginalia, but links to a habit goal or a user-practice and carries an
accept/dismiss lifecycle. This issue adds the data layer only — no endpoints,
no LLM. Mirror `models/marginalia.py` and its migration
`f6e5d4c3b2a1_add_marginalia.py` exactly (CHECK-constraint style, FK indexes,
timezone-aware timestamps).

## Tasks

### 1. Enums + model — `backend/src/models/completion_suggestion.py`

- `class CompletionTargetType(StrEnum)`: `HABIT = "habit"`, `PRACTICE = "practice"`.
- `class SuggestionStatus(StrEnum)`: `PENDING`, `ACCEPTED`, `DISMISSED`.
- `class CompletionSuggestion(SQLModel, table=True)` with the canonical columns
  from the epic contract:
  - `id` PK; `journal_entry_id` (FK `journalentry.id`, `ondelete="CASCADE"`);
    `user_id` (FK `user.id`, `ondelete="CASCADE"`) — denormalized owner so
    "all suggestions for a user" needs no JOIN (matches `Marginalia.user_id`).
  - `target_type: str` (max_length 20); `goal_id: int | None`
    (FK `goal.id`, `ondelete="CASCADE"`); `user_practice_id: int | None`
    (FK `userpractice.id`, `ondelete="CASCADE"`).
  - `label: str` (max_length 255) — display-name snapshot.
  - `anchor_start` (ge=0), `anchor_end` (ge=1), `anchor_text` (max_length 280).
  - `status: str` (default `PENDING`, max_length 20);
    `accepted_at: datetime | None` (tz-aware column).
  - `created_at` / `updated_at` tz-aware, with the `onupdate` bump (copy the
    `Marginalia` column definitions verbatim).
- `__table_args__`: indexes `ix_completion_suggestion_journal_entry_id` and
  `ix_completion_suggestion_user_id`; CHECK constraints, each built by a small
  helper deriving the allowed set from the enum (copy `_kind_check` /
  `_status_check` pattern so the DB set can't drift):
  - `ck_completion_suggestion_target_type_valid`
  - `ck_completion_suggestion_status_valid`
  - `ck_completion_suggestion_anchor_start_nonneg`
  - `ck_completion_suggestion_anchor_span_positive`
  - `ck_completion_suggestion_target_fk_matches` — the polymorphic invariant:
    `(target_type = 'habit') = (goal_id IS NOT NULL) AND (target_type =
    'practice') = (user_practice_id IS NOT NULL)`. Encode as two paired
    equalities so exactly one FK is set and it matches the type.
- Add the back-reference on `JournalEntry` (a `suggestions` relationship with
  CASCADE delete-orphan) mirroring `marginalia`, and keep `TYPE_CHECKING`
  imports clean.

### 2. Migration — `backend/migrations/versions/<rev>_add_completion_suggestion.py`

- `alembic revision -m "add completion_suggestion table"` chained from the
  **current head** (run `alembic heads`); copy `f6e5d4c3b2a1_add_marginalia.py`
  structure: `op.create_table("completion_suggestion", …)` with every column,
  FK (`ondelete="CASCADE"`), the named CHECK constraints, and the two indexes;
  `downgrade` drops the table. Purely additive.
- `alembic check` must be clean (model and migration agree) — this is a CI gate.

## Tasks — tests (`backend/tests/test_completion_suggestion_model.py`)

- A valid `habit` row (goal_id set, user_practice_id null) and a valid
  `practice` row persist; round-trip the enum-typed columns.
- The `ck_completion_suggestion_target_fk_matches` CHECK rejects: habit row with
  null goal_id; habit row that *also* sets user_practice_id; practice row with
  null user_practice_id. (Use the same DB-constraint test style as
  `test_marginalia_model.py`.)
- Anchor CHECKs reject `anchor_end <= anchor_start` and negative `anchor_start`.
- Invalid `target_type` / `status` rejected by their CHECKs.
- Deleting the parent `JournalEntry` cascades the suggestion away.
- A guard test asserts the model's CHECK sets equal the enums (drift guard,
  mirroring `test_resonance_service`'s enum guard).

## Acceptance criteria

- [ ] `CompletionSuggestion` + the two enums exist with all contract columns,
      indexes, and CHECK constraints; `JournalEntry.suggestions` back-ref added.
- [ ] Migration creates/drops the table; `alembic check` clean; SQLite test DB
      (`metadata.create_all`) inherits the same constraints.
- [ ] New tests pass; `./scripts/backend/check-all.sh` green; thresholds held.

## Files

| File | Action |
|------|--------|
| `backend/src/models/completion_suggestion.py` | New — enums + model |
| `backend/src/models/journal_entry.py` | Modify — `suggestions` relationship |
| `backend/src/models/__init__.py` | Modify — export the new model if the package re-exports |
| `backend/migrations/versions/<rev>_add_completion_suggestion.py` | New — additive migration |
| `backend/tests/test_completion_suggestion_model.py` | New — constraint + cascade tests |

## Constraints

- Copy the `marginalia` model/migration idioms (CHECK helpers, tz-aware
  columns, FK indexes) — do not invent a new style. No magic numbers: column
  caps live as named module constants like `_ANCHOR_TEXT_MAX` in `marginalia`.
