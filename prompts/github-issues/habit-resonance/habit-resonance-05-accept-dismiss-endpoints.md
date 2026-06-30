# habit-resonance-05: Accept / dismiss endpoints — habit check-off logs a `GoalCompletion`

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** 01 (model), 04 (suggestions persisted) · **Scope:** Backend ·
**Est. LoC:** ~240

## Problem

A pending suggestion needs two verbs. **Accept** is the "OK" the user taps: it
must log today's completion *exactly* as the check-in screen does — same
idempotency, same streak/milestone computation — and flip the suggestion to
`accepted`. **Dismiss** quietly retires it. This issue ships the **habit**
target (`goal_id`); practice accept is issue 08.

## Tasks

### 1. Reuse the check-in recording path

`routers/goal_completions.py` already records a `GoalCompletion` with day-scoped
idempotency and streak/milestone math. **Do not reimplement it.** Extract the
core into a service if it isn't already callable without the request layer, e.g.
`services/checkin.record_goal_completion(session, *, goal, habit, user_id,
user_timezone, day=None) -> CheckInResult`, and have the existing route call the
extracted function (no behavior change to `/goal_completions/`; its tests stay
green). The accept endpoint calls the same function.

### 2. `POST /journal/suggestions/{suggestion_id}/accept`

- Load the caller's own suggestion (`user_id` scope → 404 otherwise,
  enumeration-safe, like `_load_user_marginalia`).
- Idempotency by status:
  - `accepted` ⇒ return it unchanged (no second completion).
  - `dismissed` ⇒ `409`/`422 suggestion_dismissed` (can't accept a retired one).
  - `pending` ⇒ proceed.
- `habit` target: load the `goal_id`'s goal + parent habit (reuse
  `_get_owned_goal_and_habit`-style ownership; 404 if the goal/habit vanished).
  Resolve the user's timezone (`current_user_timezone`) and call
  `record_goal_completion(...)` for **today**, `completed_units = goal.target`.
  This is idempotent per goal+day, so an already-checked-in day doesn't
  double-log — the suggestion still settles to `accepted`.
- `practice` target: out of scope here — return `422
  practice_accept_not_supported` (issue 08 replaces this with the real path).
  Keep the branch explicit so 08 is a small diff.
- Set `status = ACCEPTED`, `accepted_at = now`, commit, return the updated
  `CompletionSuggestionResponse` **plus** the `CheckInResult` (streak +
  milestones) so the card can show "✓ Checked off — N-day streak". Define a
  small `AcceptSuggestionResponse { suggestion, check_in }` wrapper.
- Log `completion_suggestion_accepted`.

### 3. `POST /journal/suggestions/{suggestion_id}/dismiss`

- Load the caller's own suggestion (404 scope). `pending` ⇒ `DISMISSED`;
  `dismissed` ⇒ idempotent no-op return; `accepted` ⇒ `409/422
  suggestion_already_accepted` (don't silently undo a logged completion). Return
  the suggestion. Log `completion_suggestion_dismissed`.

## Tasks — tests (`backend/tests/test_completion_suggestion_endpoints.py`)

- Accept a pending habit suggestion ⇒ a `GoalCompletion` for the clear goal
  exists for today; response `status == "accepted"`, `accepted_at` set,
  `check_in.streak >= 1`.
- Accept is idempotent: calling twice logs **one** completion (assert count) and
  returns the same accepted suggestion; accepting on a day already checked-in via
  `/goal_completions/` doesn't add a second completion but still flips to
  accepted.
- Accept a `dismissed` suggestion ⇒ 409/422; accept a `practice` suggestion ⇒
  `422 practice_accept_not_supported`.
- Dismiss a pending ⇒ `dismissed`; dismiss is idempotent; dismiss an `accepted`
  ⇒ 409/422.
- Ownership: another user's / missing suggestion ⇒ 404 for both verbs.
- The extracted `record_goal_completion` keeps `/goal_completions/` tests green
  (regression assertion that the route still behaves identically).

## Acceptance criteria

- [ ] Accepting a pending habit suggestion logs today's completion via the
      **shared** check-in path (idempotent per goal/day), flips to `accepted`,
      and returns streak + milestones.
- [ ] Dismiss flips pending → dismissed; both verbs are idempotent and
      ownership-scoped (404); illegal transitions 409/422.
- [ ] Practice accept is an explicit, tested `422` placeholder for issue 08.
- [ ] `/goal_completions/` behavior unchanged; all its tests still pass.
- [ ] `./scripts/backend/check-all.sh` green; thresholds held.

## Files

| File | Action |
|------|--------|
| `backend/src/services/checkin.py` | New (or extend) — `record_goal_completion` extracted from the router |
| `backend/src/routers/goal_completions.py` | Modify — call the extracted service (no behavior change) |
| `backend/src/routers/journal.py` | Modify — accept + dismiss endpoints |
| `backend/src/schemas/completion_suggestion.py` | Modify — `AcceptSuggestionResponse` |
| `backend/tests/test_completion_suggestion_endpoints.py` | New |

## Constraints

- **Reuse the streak/idempotency math**, don't fork it — the whole point is that
  a journal check-off and a manual check-in are indistinguishable in the data.
- Status transitions are explicit and total (pending/accepted/dismissed × verb);
  never silently undo a logged completion. Errors use the existing `errors.py`
  helpers and the project's `detail` string convention.
