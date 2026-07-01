# capability-registry-05: Capability execute handlers + generic accept endpoint

**Labels:** `enhancement`, `architecture`, `backend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 01, 03, 04
**Estimated LoC:** ~300

## Role

You are the engineer unifying the hand-written per-target accept handlers
(`_accept_pending_habit` / `_accept_pending_practice` in
`backend/src/routers/journal.py:819-843`) into one registry-dispatched path, so
accepting *any* capability proposal runs that capability's own `execute` handler.

## Goal

Give each `Capability` an `execute(ctx, target_id, verb, params)` handler and
replace the target-specific accept branches with a generic
`POST /suggestions/{id}/accept` that: loads the `ActionSuggestion`, verifies
ownership, verifies the target still exists and is owned, dispatches to the
capability's handler, and flips the suggestion to `accepted` (idempotently).
Dismiss stays generic and terminal.

## Context

Accepting a habit today calls `record_goal_completion`; accepting a practice
creates a `PracticeSession`. These become the `execute` handlers of the `habit`
and `practice` capabilities. New capabilities (wheel note, enable-ring, later a
shortcut run) supply their own handler and need no endpoint changes.

## Tasks

1. **Handler protocol** in `domain/capabilities.py`: add `execute` to the
   `Capability` (a callable/Protocol taking an injected context — session,
   current user, timezone — plus `target_id`, `verb`, `params`) returning a
   small result payload (e.g. `{"logged": true, "streak": 4}`).
2. **Move existing accept logic** into handlers registered on the `habit` and
   `practice` capabilities (`capability_defs.py`): habit → `record_goal_completion`
   (via the representative goal resolution already in
   `services/completion_candidates.py`); practice → create `PracticeSession`.
   Preserve idempotency (`practice_session_idempotency`) and ownership checks
   (`dependencies/ownership.py`).
3. **Generic endpoint** in `routers/journal.py` (or a new `routers/suggestions.py`):
   `POST /suggestions/{id}/accept` → resolve capability by `suggestion.capability_key`,
   re-validate `target_id` ownership/existence **now** (since 03 dropped DB FKs),
   dispatch `execute`, set `status=accepted`, `accepted_at`. `POST /suggestions/{id}/dismiss`
   stays generic. Both idempotent and ownership-guarded; keep the legacy
   `accept_suggestion` route working as a thin alias for one release.
4. **Care gate:** an accept for an action capability is refused (409/care
   payload) if the entry is flagged for distress — actions never fire under a
   care signal.
5. **Tests:** habit + practice accept parity (existing tests green through the
   generic path); a new capability handler round-trip; ownership rejection when
   `target_id` belongs to another user; idempotent double-accept.

## Acceptance Criteria

- [ ] One generic accept endpoint dispatches every capability; no per-target branches remain.
- [ ] Habit/practice accept behaviour (completion logged, streak/session updated) unchanged; their tests pass.
- [ ] `target_id` ownership/existence is re-validated at accept time (compensating for the dropped FKs in 03).
- [ ] Accept is idempotent; dismiss is terminal; both reject cross-user targets.
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/domain/capabilities.py` | Modify (execute protocol) |
| `backend/src/domain/capability_defs.py` | Modify (register handlers) |
| `backend/src/routers/suggestions.py` | **Create** (or extend `journal.py`) |
| `backend/src/main.py` | Modify (mount router if new) |
| `backend/tests/test_suggestions_accept.py` | **Create** |
| `backend/tests/test_journal_suggestions.py` | Modify (parity) |

## Constraints

- Because 03 removed per-type FKs, the accept path is the ownership boundary —
  it MUST re-check that `target_id` exists and belongs to `current_user`.
- Handlers reuse existing domain services (`record_goal_completion`,
  `PracticeSession` creation, idempotency) — do not duplicate that logic.
- No auto-execution anywhere: `execute` runs only from an explicit accept.
