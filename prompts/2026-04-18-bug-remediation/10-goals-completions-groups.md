# Goals, Completions & Groups Bug Report — 2026-04-18

**Scope:** `backend/src/routers/goal_completions.py` (116 LOC), `backend/src/routers/goal_groups.py` (182 LOC), `backend/src/domain/goals.py` (34 LOC), `backend/src/domain/milestones.py` (15 LOC). Covers goal completion write path (tier/streak/milestone updates), goal-group CRUD, and the supporting domain logic.

**Total bugs: 10 — 3 Critical / 5 High / 2 Medium / 0 Low**

## Executive Summary

1. **Authorization catastrophes (Critical).** BUG-GOAL-005: `create_goal_group` honors a client-supplied `user_id`, so any authenticated user can plant a group under another account. BUG-GOAL-006: "shared template" groups — meant to be curated content — are editable and deletable by every authenticated user.
2. **Concurrency + atomicity on the completion write path (Critical/High).** BUG-GOAL-001: `POST /completions` has a TOCTOU race — two parallel POSTs for the same `(goal_id, date)` produce two rows, doubling the streak increment. BUG-GOAL-002: the streak returned in the response is read before the new row is committed, showing a stale value to the client. BUG-GOAL-003: the three-step write (completion insert, streak bump, milestone step) is not wrapped in a single transaction, so a milestone-step failure leaves a committed completion with a stale streak.
3. **Timezone and backdating (High).** BUG-GOAL-004: `_already_logged_today` uses server UTC midnight rather than the user's local day — pair with BUG-STREAK-002 and BUG-HABIT-006. BUG-GOAL-007: `GoalCompletionRequest` ignores `did_complete=False` idempotency and places no cap on historical-date backdating.
4. **Silent domain stubs (High/Medium).** BUG-GOAL-010: `domain/milestones.achieved_milestones` is a 15-line stub that returns a success-shaped tuple regardless of actual progress — the tier UI shows celebrations for goals that weren't met. BUG-GOAL-009: `compute_progress` silently returns 0 for negative `current` instead of raising, hiding upstream bugs.
5. **N+1 + pagination gaps (Medium).** BUG-GOAL-008: `list_goal_groups` returns shared templates unpaged and lazy-loads each group's goals per iteration.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-GOAL-005 | Critical | `routers/goal_groups.py` | `create_goal_group` double-applies client `user_id` |
| 2 | BUG-GOAL-006 | Critical | `routers/goal_groups.py` | Shared templates editable/deletable by any user |
| 3 | BUG-GOAL-001 | Critical | `routers/goal_completions.py` | TOCTOU duplicate-completion race |
| 4 | BUG-GOAL-002 | High | `routers/goal_completions.py` | Streak returned from pre-insert state (stale) |
| 5 | BUG-GOAL-003 | High | `routers/goal_completions.py` | Three-step write not transactional |
| 6 | BUG-GOAL-004 | High | `routers/goal_completions.py` | `_already_logged_today` uses server UTC midnight |
| 7 | BUG-GOAL-007 | High | `routers/goal_completions.py` | `did_complete=False` not idempotent; backdating uncapped |
| 8 | BUG-GOAL-010 | High | `domain/milestones.py` | `achieved_milestones` silent-success stub |
| 9 | BUG-GOAL-008 | Medium | `routers/goal_groups.py` | `list_goal_groups` N+1 on goals; shared templates unpaged |
| 10 | BUG-GOAL-009 | Medium | `domain/goals.py` | `compute_progress` silently returns 0 on negative input |

---

# Fragment 10 — Goals Surface Bug Audit

Scope: `backend/src/routers/goal_completions.py`, `backend/src/routers/goal_groups.py`,
`backend/src/domain/goals.py`, `backend/src/domain/milestones.py`.

Bug ID namespace: `BUG-GOAL-NNN` (10 entries).

---

### BUG-GOAL-001 — TOCTOU duplicate-completion race on concurrent POSTs (Severity: Critical)

**Component:** `backend/src/routers/goal_completions.py:53-98` (`_already_logged_today` / `create_goal_completion`)

**Symptom:** Two clients (or one client with a double-tap / retry) posting simultaneously for the same `(goal_id, user_id, today)` both pass the "already logged" check and both `INSERT`, producing two `GoalCompletion` rows. Streaks, progress, and any downstream tier transitions count the day twice.

**Root cause:**
```python
if await _already_logged_today(session, payload.goal_id, current_user):
    return CheckInResult(streak=old_streak, milestones=[], reason_code="already_logged_today")

completed_units = goal.target if payload.did_complete else 0
session.add(
    GoalCompletion(
        goal_id=payload.goal_id, user_id=current_user, completed_units=completed_units
    )
)
await session.commit()
```
The SELECT and the INSERT are two independent statements with no row lock and no unique constraint. Under concurrency both transactions read "no row today" and both insert. `GoalCompletion` has no `UNIQUE(goal_id, user_id, day)` index.

**Fix:** Add a generated `completion_day` column (or trunc-date expression index) and a `UNIQUE(goal_id, user_id, completion_day)` constraint in a new Alembic migration. Catch `IntegrityError` in the router and translate it to the existing `already_logged_today` response. Alternatively wrap the check+insert in `SELECT ... FOR UPDATE` on the parent `Goal` row to serialize writers.

**Cross-references:** BUG-STREAK-002 (concurrency race), BUG-DB-002 (timestamp race).

---

### BUG-GOAL-002 — Streak returned to client computed from pre-insert state (Severity: High)

**Component:** `backend/src/routers/goal_completions.py:83-114` (`create_goal_completion`)

**Symptom:** The response `streak` field is derived by calling `update_streak(old_streak, did_complete)` against the *old* streak count without re-reading the DB after insert. If `compute_consecutive_streak` and `update_streak` disagree (e.g. gap-handling differences, timezone edge cases, or a concurrent insert by another request), the client sees a streak number that does not match the true persisted state. Subsequent pulls will show a different number, confusing users.

**Root cause:**
```python
old_streak = await compute_consecutive_streak(session, goal.id, current_user)
...
session.add(GoalCompletion(...))
await session.commit()
new_streak, reason = update_streak(old_streak, payload.did_complete)
...
return CheckInResult(
    streak=new_streak,
    milestones=check_milestones(new_streak, _DEFAULT_THRESHOLDS, old_streak),
    reason_code=reason,
)
```
Two sources of truth (`update_streak` arithmetic vs. `compute_consecutive_streak` DB read) for the same number.

**Fix:** After commit, re-invoke `await compute_consecutive_streak(session, goal.id, current_user)` and return that. Use the pure `update_streak` only for its `reason_code`, not the numeric streak value.

**Cross-references:** BUG-STREAK-002.

---

### BUG-GOAL-003 — Non-atomic write: completion commits even if streak/milestone step later fails (Severity: High)

**Component:** `backend/src/routers/goal_completions.py:93-114` (`create_goal_completion`)

**Symptom:** The completion row is committed before the milestone/streak computation runs. If `check_milestones` or `update_streak` raises (bad enum, None from stub, arithmetic error) the user gets a 500 but the completion row is already persisted — the client will retry and the idempotency check saves them, but any future side-effect such as tier transition, notification, or analytics event that the caller expects is silently dropped. There is no compensating rollback.

**Root cause:**
```python
session.add(GoalCompletion(...))
await session.commit()                         # <-- committed

new_streak, reason = update_streak(old_streak, payload.did_complete)
...
return CheckInResult(
    streak=new_streak,
    milestones=check_milestones(new_streak, _DEFAULT_THRESHOLDS, old_streak),
    reason_code=reason,
)
```

**Fix:** Build the full response (streak, milestones, reason) inside the same transaction before calling `session.commit()`. If any computation raises, `await session.rollback()` and surface an error. Alternatively wrap the whole handler in a `session.begin()` context so either everything persists or nothing does.

**Cross-references:** BUG-STREAK-002, BUG-HABIT-004.

---

### BUG-GOAL-004 — `_already_logged_today` uses server UTC midnight, not user's local day (Severity: High)

**Component:** `backend/src/routers/goal_completions.py:53-65` (`_already_logged_today`)

**Symptom:** A user in PT logs a completion at 4 PM local (23:00 UTC). They log again at 5 PM local (00:00 UTC next day). From the user's perspective both are "today" and the second should be blocked, but the UTC-midnight boundary flips between the two, so the second insert is allowed and the day is double-counted. Symmetric problem in the other direction for users east of UTC.

**Root cause:**
```python
today_start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
result = await session.execute(
    select(GoalCompletion.id)
    .where(
        GoalCompletion.goal_id == goal_id,
        GoalCompletion.user_id == user_id,
        GoalCompletion.timestamp >= today_start,
    )
    .limit(1)
)
```

**Fix:** Store the user's IANA timezone on `User` (or accept it as a request-scoped header) and compute `today_start` / `today_end` in that zone, then convert back to UTC for the range query. Add a `completion_day` column populated with the zoned date to enable the unique index from BUG-GOAL-001.

**Cross-references:** BUG-DB-002, BUG-STREAK-002.

---

### BUG-GOAL-005 — `create_goal_group` double-applies `user_id` from payload (Severity: Critical)

**Component:** `backend/src/routers/goal_groups.py:106-118` (`create_goal_group`)

**Symptom:** `GoalGroupCreate` does not expose `user_id`, but `GoalGroup.__init__` does. The construction `GoalGroup(user_id=..., **payload.model_dump())` is safe today only because the schema happens to omit that field. If `GoalGroupCreate` ever grows a `user_id` attribute (or if a client sneaks one through a loose parent schema) the kwargs would clash and raise `TypeError` at request time — or worse, overwrite the server-set ownership and let user A create a group as user B. Additionally, when `shared_template=True` the explicit kwarg sets `user_id=None`, but no authorization check prevents a regular user from creating shared templates, so any authenticated user can seed the "built-in" template list.

**Root cause:**
```python
group = GoalGroup(
    user_id=current_user if not payload.shared_template else None,
    **payload.model_dump(),
)
session.add(group)
await session.commit()
```

**Fix:** Require admin/staff role to set `shared_template=True`; otherwise force `payload.shared_template = False` server-side. Use `payload.model_dump(exclude={"shared_template"})` and set `shared_template` explicitly so the authorization invariant is visible at the call site. Add `extra="forbid"` to `GoalGroupCreate` so unknown fields raise 422 rather than silently flow through `**payload.model_dump()`.

**Cross-references:** BUG-MODEL-002.

---

### BUG-GOAL-006 — Shared templates editable and deletable by any authenticated user (Severity: Critical)

**Component:** `backend/src/routers/goal_groups.py:143-182` (`update_goal_group`, `delete_goal_group`)

**Symptom:** The ownership predicate `group.user_id is not None and group.user_id != current_user` treats `user_id IS NULL` (shared templates) as "accessible to me". A regular user can `PUT /goal-groups/{template_id}` to rename the built-in "Meditation Goals" template, or `DELETE` it outright, unlinking all goals globally and breaking the template list for every other user.

**Root cause:**
```python
group = await session.get(GoalGroup, group_id)
if group is None or (group.user_id is not None and group.user_id != current_user):
    raise not_found("goal_group")
for key, value in payload.model_dump().items():
    setattr(group, key, value)
...
# delete_goal_group, same predicate:
if group is None or (group.user_id is not None and group.user_id != current_user):
    raise not_found("goal_group")
```

**Fix:** Change the predicate to reject shared templates for write verbs: `if group is None or group.shared_template or group.user_id != current_user: raise not_found(...)`. Only an admin role should be allowed to mutate `shared_template=True` rows, and even then go through a separate admin router.

**Cross-references:** BUG-MODEL-002, BUG-HABIT-004.

---

### BUG-GOAL-007 — `GoalCompletionRequest` ignores `did_complete=False` idempotency & has no cap on backdating path (Severity: High)

**Component:** `backend/src/routers/goal_completions.py:31-35, 68-97` (`GoalCompletionRequest`, `create_goal_completion`)

**Symptom:** `did_complete=False` records a "miss" row with `completed_units=0`. The idempotency guard still fires (returns the old streak unchanged), so a user who accidentally submits a miss then realises and submits a completion cannot correct the record — they are permanently marked missed for the day. There is also no server-side validation that `goal.target > 0` before multiplying; a goal with `target=0` (allowed by the model — only `target: float` with no `gt=0`) records `completed_units=0` for a successful check-in, silently voiding the day. Finally, `GoalCompletionRequest` has no `extra="forbid"` and no `completed_at` clamp — if the field is added later it will accept arbitrary client timestamps.

**Root cause:**
```python
class GoalCompletionRequest(BaseModel):
    goal_id: int
    did_complete: bool = True
...
completed_units = goal.target if payload.did_complete else 0
session.add(
    GoalCompletion(
        goal_id=payload.goal_id, user_id=current_user, completed_units=completed_units
    )
)
```

**Fix:** Add an "overwrite today's record" PATCH endpoint (or accept `did_complete` overwrite when the same-day row exists and `did_complete` differs). Enforce `target > 0` at the schema layer for `Goal`. Add `model_config = ConfigDict(extra="forbid")` to `GoalCompletionRequest` so unexpected fields (including a future client-supplied `completed_at`) are rejected immediately.

**Cross-references:** BUG-SCHEMA-002, BUG-STREAK-002.

---

### BUG-GOAL-008 — `list_goal_groups` returns shared templates without pagination semantics and has an N+1 on goals (Severity: Medium)

**Component:** `backend/src/routers/goal_groups.py:62-86` (`list_goal_groups`)

**Symptom:** The query joins user-owned groups with every `shared_template=True` row and paginates the combined set. When a user has 3 personal groups and there are 50 shared templates, page 1 of size 10 shows a deterministic-but-surprising mix; page N can be empty. Additionally, `ensure_seed_templates` runs on every list call — it issues a SELECT + commits a transaction for a no-op 99.9% of the time, adding latency and log noise, and on a fresh DB it races with concurrent callers each inserting the same three seeds. `GOAL_GROUP_WITH_GOALS` eager-loads goals per group, but there is no `order_by`, so pagination results are nondeterministic across pages.

**Root cause:**
```python
await ensure_seed_templates(session)
query = (
    select(GoalGroup)
    .where(
        (GoalGroup.user_id == current_user) | (GoalGroup.shared_template == True)  # noqa: E712
    )
    .options(GOAL_GROUP_WITH_GOALS)
)
items, total = await paginate_query(session, query, pagination)
```

**Fix:** Move `ensure_seed_templates` to an Alembic data migration or app-startup hook instead of running it per-request. Add `.order_by(GoalGroup.shared_template.desc(), GoalGroup.id)` for stable pagination. Consider splitting the endpoint into `/goal-groups/mine` and `/goal-groups/templates` so pagination is coherent on each. Add a unique constraint `UNIQUE(name) WHERE shared_template = true` to eliminate the seed race.

**Cross-references:** BUG-DB-002.

---

### BUG-GOAL-009 — `domain/goals.compute_progress` can silently return 0 for negative `current` (Severity: Medium)

**Component:** `backend/src/domain/goals.py:24-34` (`compute_progress`)

**Symptom:** The docstring and formula assume `current >= 0`. If a caller passes a negative `current` (e.g. "ate -50 mg caffeine" from a buggy upstream computation), the additive branch clamps to 0 (ok), but the subtractive branch returns `1.0` — representing *more* progress than zero intake — rewarding nonsense data. The function also has no input type coercion for `current` or `target`; passing strings from JSON will raise `TypeError` at the divide rather than a schema-level 422. Finally, `target <= 0` raises `ValueError`, but callers in the router do not catch it, so a malformed goal yields a 500.

**Root cause:**
```python
if target <= 0:
    raise ValueError("target must be positive")

if is_additive:
    progress = max(0.0, min(current / target, 1.0))
    return progress, "additive_progress"

# Subtractive: success is staying *under* the target.
progress = max(0.0, min(1.0 - current / target, 1.0))
return progress, "subtractive_progress"
```

**Fix:** Add `if current < 0: raise ValueError("current must be non-negative")` at the top. Translate domain `ValueError`s to HTTP 422 at the router boundary via an exception handler. Use `Decimal` or validated `Annotated[float, Field(ge=0)]` at the schema layer so malformed inputs never reach the domain function.

**Cross-references:** BUG-SCHEMA-002.

---

### BUG-GOAL-010 — `domain/milestones.achieved_milestones` is a silent stub returning `(reached, "milestones_achieved")` regardless of state (Severity: High)

**Component:** `backend/src/domain/milestones.py:8-15` (`achieved_milestones`)

**Symptom:** Per BUG-SCHEMA-002 the milestone flow is a stub. `achieved_milestones` returns every threshold `<= value` on every call, with no concept of *newly* crossed vs. previously achieved. The completion router actually imports `check_milestones` from `services.streaks` rather than this function, so `achieved_milestones` is dead code; however, any future caller wiring it up will ship a bug where the client sees the full reached list on every check-in and re-celebrates the 1-day, 3-day, 7-day milestones forever. Additionally, the function does not sort `reached` (depends on iteration order of `thresholds`) and returns a list rather than a frozen view, so a caller mutating it pollutes shared module-level constants like `_DEFAULT_THRESHOLDS`.

**Root cause:**
```python
def achieved_milestones(value: int, thresholds: Iterable[int]) -> tuple[list[int], str]:
    """Return thresholds that have been met by ``value``.

    The result includes a ``reason_code`` for auditability.
    """

    reached: list[int] = [t for t in thresholds if value >= t]
    return reached, "milestones_achieved"
```

**Fix:** Either delete this module (it is unused — the router uses `services.streaks.check_milestones`) or promote it to the real implementation by taking `old_value` and returning only `[t for t in thresholds if old_value < t <= value]`, sorted ascending. Add a unit test that asserts the dedup behaviour. Mark the module `__all__` and raise `NotImplementedError` until wired, so a silent wrong answer cannot be shipped.

**Cross-references:** BUG-SCHEMA-002, BUG-STREAK-002.

---

## Summary

| Bug | Severity | Area |
| --- | --- | --- |
| BUG-GOAL-001 | Critical | goal_completions — idempotency race |
| BUG-GOAL-002 | High | goal_completions — streak source of truth |
| BUG-GOAL-003 | High | goal_completions — non-atomic commit |
| BUG-GOAL-004 | High | goal_completions — UTC vs. local "today" |
| BUG-GOAL-005 | Critical | goal_groups — ownership bypass on create |
| BUG-GOAL-006 | Critical | goal_groups — shared-template write access |
| BUG-GOAL-007 | High | goal_completions — miss/complete overwrite + target=0 |
| BUG-GOAL-008 | Medium | goal_groups — pagination + seed race + N+1 |
| BUG-GOAL-009 | Medium | domain/goals — negative current returns full progress |
| BUG-GOAL-010 | High | domain/milestones — silent stub returning all-reached |

---

## Suggested Remediation Order

1. **BUG-GOAL-005** (Critical) — Drop `user_id` from `GoalGroupCreate` entirely; set it server-side from `current_user`. Add a regression test that a forged payload `{ "user_id": OTHER_USER, ... }` is rejected or silently ignored.
2. **BUG-GOAL-006** (Critical) — Gate `update_goal_group` / `delete_goal_group` on ownership; shared templates must require admin (pair with BUG-ADMIN-001 once `is_admin` exists).
3. **BUG-GOAL-001** (Critical) — Add a unique index on `(goal_id, completion_date)` at the DB layer so the second concurrent POST fails with `IntegrityError`; catch and return 200 with the canonical row (idempotent). Alternatively, `SELECT ... FOR UPDATE` on the goal row.
4. **BUG-GOAL-003 / -002** (High) — Wrap the completion insert + streak bump + milestone step in a single `session.begin()`; compute the response streak from the post-commit state.
5. **BUG-GOAL-010** (High) — Implement `achieved_milestones` to compare `current` against ordered thresholds; raise (or return `None`) if the goal has no milestones. Add unit tests for boundary cases.
6. **BUG-GOAL-004** (High) — Use `ZoneInfo(user.timezone)` on the completion timestamp (pair with BUG-HABIT-006, BUG-STREAK-002).
7. **BUG-GOAL-007** (High) — Make `did_complete=False` idempotent (DELETE or no-op). Cap `completed_at` backdating (e.g. `ge=now()-7d`) at the schema layer.
8. **BUG-GOAL-008 / -009** (Medium) — Add `Page[T]` pagination and `selectinload(GoalGroup.goals)` on the list endpoint. Make `compute_progress` raise `ValueError` for negatives.

## Cross-References

- **BUG-SCHEMA-002** (Milestone one-field stub) — BUG-GOAL-010 is the business-logic side of that same gap.
- **BUG-SCHEMA-006** (StageProgressUpdate unbounded) — thematic pair: client-controllable progression state.
- **BUG-MODEL-002** (FK ondelete gaps) — BUG-GOAL-008 / -006 depend on clean cascade for group delete.
- **BUG-HABIT-004** (hard-delete hazard) — BUG-GOAL-003's atomicity bug would make a hard delete even worse.
- **BUG-HABIT-006 / BUG-STREAK-002** (UTC day boundaries / concurrency) — BUG-GOAL-001 / -004 are the goal-side mirrors.
- **BUG-DB-002** (timestamp race on sessions) — systemic theme.
- **BUG-ADMIN-001** (no `is_admin`) — BUG-GOAL-006 cannot be properly fixed until admin identity exists.
