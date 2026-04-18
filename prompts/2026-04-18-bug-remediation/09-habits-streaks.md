# Habits & Streaks Bug Report — 2026-04-18

**Scope:** `backend/src/routers/habits.py` (150 LOC), `backend/src/domain/habit_stats.py` (97 LOC), `backend/src/domain/streaks.py` (11 LOC), `backend/src/services/streaks.py` (104 LOC). Covers habit CRUD, completion-tracking stats, streak computation and service-layer orchestration.

**Total bugs: 10 — 1 Critical / 4 High / 4 Medium / 1 Low**

## Executive Summary

1. **Streak race + timezone drift (Critical/High).** BUG-STREAK-002: `compute_consecutive_streak` extracts dates from naive UTC timestamps and lacks a row-level lock, so concurrent completion POSTs on the same local day race into inconsistent streak counts. BUG-HABIT-006: `compute_habit_stats` formats dates with `strftime` on UTC-naive timestamps, breaking streaks for any user west of UTC-00 whose "today" straddles midnight server-time.
2. **Cadence-aware streaks missing (High).** BUG-STREAK-001: `update_streak` zeroes the streak on any missed calendar day, even when the habit's `notification_days` says "Mon/Wed/Fri". Users intentionally skipping Tuesday lose their streak.
3. **Habit response leaks + hard delete (High).** BUG-HABIT-001: every habit DTO echoes `user_id` (pairs with BUG-SCHEMA-001). BUG-HABIT-004: `delete_habit` is a hard `DELETE` that cascades silently on some children but orphans on others (pairs with BUG-MODEL-002).
4. **Input limits absent at the router (Medium).** No per-user habit cap, no duplicate-name guard, list endpoints are unbounded. Pairs with BUG-SCHEMA-004 (HabitCreate missing bounds).
5. **Off-by-one and div-by-zero (Medium).** `compute_habit_stats` divides by zero on first-day accounts and uses inclusive/exclusive edges inconsistently across weekly/monthly rollups.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-STREAK-002 | Critical | `services/streaks.py` | Concurrent completions race, UTC date boundary drift |
| 2 | BUG-STREAK-001 | High | `domain/streaks.py` | Missed-day reset ignores `notification_days` cadence |
| 3 | BUG-HABIT-001 | High | `routers/habits.py` | Habit response leaks `user_id` (ORM auto-serialization) |
| 4 | BUG-HABIT-004 | High | `routers/habits.py` | `delete_habit` is hard delete with no cascade contract |
| 5 | BUG-HABIT-006 | High | `domain/habit_stats.py` | Day labels & completion dates computed in UTC |
| 6 | BUG-HABIT-002 | Medium | `routers/habits.py` | No per-user habit cap / duplicate-name guard |
| 7 | BUG-HABIT-003 | Medium | `routers/habits.py` | IDOR probe: audit-log + timing side channel |
| 8 | BUG-HABIT-005 | Medium | `routers/habits.py` | N+1 risk on `list_habits` with pagination bypass |
| 9 | BUG-HABIT-007 | Medium | `domain/habit_stats.py` | `_completion_rate` off-by-one, ignores cadence |
| 10 | BUG-HABIT-008 | Low | `domain/habit_stats.py` | Dates re-parsed from strings 3× per streak call |

---

# Fragment 09 — Habits Router + Streaks Service/Domain

Scope: `backend/src/routers/habits.py`, `backend/src/domain/habit_stats.py`,
`backend/src/domain/streaks.py`, `backend/src/services/streaks.py`.

Namespaces: `BUG-HABIT-NNN` (router + habit_stats), `BUG-STREAK-NNN` (streaks
domain + service).

---

### BUG-HABIT-001 — Habit response leaks `user_id` via ORM auto-serialization (Severity: High)

**Component:** `backend/src/routers/habits.py:35-47` (`create_habit`), also `update_habit`, `get_habit`, `list_habits`

**Symptom:** Every habit returned by the API includes the owner's `user_id`, exposing an internal primary key that callers can use to enumerate other tenants' data and pivot to account-targeting attacks.

**Root cause:**
```python
@router.post("/", response_model=HabitSchema)
async def create_habit(
    payload: HabitCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Habit:
    habit = Habit(user_id=current_user, **payload.model_dump())
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    return habit  # HabitSchema currently mirrors ORM model, incl. user_id
```

**Fix:** Split the response DTO from the ORM shape — define a `HabitResponse` schema that explicitly excludes `user_id` (and any other server-only columns), and return that. Pydantic `model_config = ConfigDict(from_attributes=True)` with an explicit field set prevents accidental leakage on future column additions.

**Cross-references:** BUG-SCHEMA-001 (HabitResponse leaks user_id).

---

### BUG-HABIT-002 — `create_habit` does not validate input bounds or uniqueness (Severity: Medium)

**Component:** `backend/src/routers/habits.py:35-47`

**Symptom:** A user can create unlimited habits, duplicate titles byte-for-byte, and submit empty or multi-kilobyte names. This degrades list-view UX, bloats the DB, and enables a trivial storage-exhaustion vector for an authenticated attacker.

**Root cause:**
```python
habit = Habit(user_id=current_user, **payload.model_dump())
session.add(habit)
await session.commit()
```
No pre-insert query for `(user_id, name)` collision; no `COUNT(*)` guard; `HabitCreate` (per BUG-SCHEMA-004) lacks `min_length`/`max_length` on string fields.

**Fix:** Add a per-user habit cap (e.g. 50) enforced with a `SELECT COUNT(*)` inside the same transaction; add a unique index on `(user_id, lower(name))` and surface `IntegrityError` as HTTP 409; tighten `HabitCreate` with Pydantic `Field(min_length=1, max_length=120)` constraints.

**Cross-references:** BUG-SCHEMA-004 (HabitCreate missing input bounds).

---

### BUG-HABIT-003 — IDOR probe via `GET /habits/{id}` returns 404 but timing/log side-channel differs (Severity: Medium)

**Component:** `backend/src/routers/habits.py:77-90` (`get_habit`), `113-126` (`delete_habit`), `93-110` (`update_habit`)

**Symptom:** The endpoints correctly reject cross-tenant reads with 404, but `update_habit` and `delete_habit` emit `logger.info("habit_updated", ...)` / `habit_deleted` only on success, while the cross-tenant path short-circuits with no corresponding `habit_access_denied` log. A probing user cannot read the body but can infer habit-id existence through server timing (`session.get` hit vs. miss) and through the absence of structured audit trails.

**Root cause:**
```python
habit = await session.get(Habit, habit_id)
if habit is None or habit.user_id != current_user:
    raise not_found("habit")
# no log line when the owner check fails
```

**Fix:** Emit a `logger.warning("habit_access_denied", extra={"user_id": current_user, "habit_id": habit_id})` on the rejection branch, and gate `get_habit`'s query with `Habit.user_id == current_user` in the `WHERE` clause so the DB returns `None` in a single round-trip regardless of ownership. This normalizes timing and adds an audit record suitable for rate-limiting.

---

### BUG-HABIT-004 — `delete_habit` is a hard delete with no cascade contract (Severity: High)

**Component:** `backend/src/routers/habits.py:113-126`

**Symptom:** Deleting a habit hard-removes the row. If the `Goal → GoalCompletion` FKs are not `ondelete="CASCADE"` (see BUG-MODEL-002), completions are orphaned and analytics break; if they are CASCADE, the user silently loses years of historical completion data with no undo.

**Root cause:**
```python
await session.delete(habit)
await session.commit()
logger.info("habit_deleted", extra={"user_id": current_user, "habit_id": habit_id})
return Response(status_code=status.HTTP_204_NO_CONTENT)
```

**Fix:** Switch to soft-delete by adding a `deleted_at: datetime | None` column on `Habit`, setting it on DELETE, and filtering `list_habits`/`get_habit`/streak queries to `deleted_at IS NULL`. Provide a separate admin purge path for true hardening. Document the cascade policy and align it with BUG-MODEL-002.

**Cross-references:** BUG-MODEL-002 (FK ondelete gaps).

---

### BUG-HABIT-005 — N+1 risk on `list_habits` when pagination bypass is used (Severity: Medium)

**Component:** `backend/src/routers/habits.py:50-74`

**Symptom:** With `?paginate=false` (the legacy path), `HABIT_WITH_GOALS_AND_COMPLETIONS` eager-loads but the per-habit `_populate_streak` loop iterates `habit.goals` / `goal.completions` in memory — fine — however `HabitWithGoals.model_validate(h, from_attributes=True)` triggers lazy-loads for any relationship not included in the loader options (e.g. goal milestones). On a user with 50 habits × 3 goals this produces up to 150 extra queries.

**Root cause:**
```python
items, total = await paginate_query(session, query, pagination)
for habit in items:
    _populate_streak(habit, current_user)
serialized = [HabitWithGoals.model_validate(h, from_attributes=True) for h in items]
```

**Fix:** Audit `HabitWithGoals` for every relationship it touches and extend `HABIT_WITH_GOALS_AND_COMPLETIONS` to cover them via `selectinload` chains; add a pytest assertion using `sqlalchemy.event` to cap the query count at O(1) for the list endpoint.

---

### BUG-HABIT-006 — `compute_habit_stats` uses UTC day boundaries, miscounting streaks for non-UTC users (Severity: High)

**Component:** `backend/src/domain/habit_stats.py:30-42`

**Symptom:** A user in UTC−8 who completes a habit at 10pm local (06:00 UTC next day) has the completion attributed to the wrong calendar day. This causes split streaks ("did it at midnight two nights in a row" counted as two non-adjacent days), wrong `day_labels` weekday alignment, and an off-by-one in `completion_rate`'s denominator.

**Root cause:**
```python
for c in completions:
    js_idx = (c.timestamp.weekday() + 1) % _DAYS_IN_WEEK
    units[js_idx] += c.completed_units
    presence[js_idx] = 1
    dates.add(c.timestamp.strftime("%Y-%m-%d"))
```
`c.timestamp` is a naive UTC `datetime`; `.weekday()` and `strftime("%Y-%m-%d")` both operate in UTC regardless of the user's locale.

**Fix:** Thread the user's IANA timezone (from the `User` model) into `compute_habit_stats`, and convert timestamps with `c.timestamp.astimezone(user_tz)` before extracting `weekday()` / `date()`. Centralize the conversion in a `to_user_local_date(ts, tz)` helper so all streak paths agree.

**Cross-references:** BUG-STREAK-002, BUG-DB-002 (timestamp backdating).

---

### BUG-HABIT-007 — `_completion_rate` off-by-one and does not reflect intended cadence (Severity: Medium)

**Component:** `backend/src/domain/habit_stats.py:71-77`

**Symptom:** The "rate" is computed as `unique_days / (last - first + 1)`, i.e. density between the first and last completion only. A user who completed a habit daily for a week then stopped for a year shows `rate = 7/7 = 1.0` forever. There is also no division-by-zero protection beyond `span > 0`, which is redundant since `last >= first` by construction.

**Root cause:**
```python
def _completion_rate(sorted_dates: list[str], unique_count: int) -> float:
    if not sorted_dates:
        return 0.0
    first = date_type.fromisoformat(sorted_dates[0])
    last = date_type.fromisoformat(sorted_dates[-1])
    span = (last - first).days + 1
    return unique_count / span if span > 0 else 0.0
```

**Fix:** Define rate relative to the user's intended cadence (e.g. `notification_days` count over the last N weeks) rather than self-referential span. Anchor the denominator to a product-decided window such as "last 30 days" or "since habit creation", and document the formula in the schema docstring. Keep the `span > 0` guard but add a unit test for the single-day edge case.

---

### BUG-HABIT-008 — `compute_habit_stats` silently re-parses dates as strings 3× per streak (Severity: Low)

**Component:** `backend/src/domain/habit_stats.py:45-68`

**Symptom:** `_aggregate_by_day` stringifies each timestamp with `strftime`, then `_longest_streak` and `_current_streak` each call `date.fromisoformat` on the same strings. This is wasted work and introduces a format-drift risk (BUG-SCHEMA-005): if the format constant ever changes to include time, both parsers silently break.

**Root cause:**
```python
dates.add(c.timestamp.strftime("%Y-%m-%d"))
...
for ds in sorted_dates:
    d = date_type.fromisoformat(ds)
```

**Fix:** Carry `date` objects through the pipeline instead of strings — store `set[date]`, sort those, and only stringify at the final `HabitStats(completion_dates=...)` boundary. Removes three `fromisoformat` calls per day and aligns with the `completion_dates: list[date]` response type (see BUG-SCHEMA-005).

**Cross-references:** BUG-SCHEMA-005 (date-string format drift).

---

### BUG-STREAK-001 — `domain.streaks.update_streak` treats any non-check-in as a reset (Severity: High)

**Component:** `backend/src/domain/streaks.py:6-11`

**Symptom:** The function resets the streak to 0 whenever `did_check_in` is False, with no concept of "today is not a scheduled day" or "the user has a grace day". For weekly habits or `notification_days = [Mon, Wed, Fri]`, calling this on a Tuesday nukes the streak.

**Root cause:**
```python
def update_streak(current_streak: int, did_check_in: bool) -> tuple[int, str]:
    if did_check_in:
        return current_streak + 1, "streak_incremented"
    return 0, "streak_reset"
```

**Fix:** Expand the signature to accept `is_scheduled_today: bool` (or a `HabitCadence` value object) and return `(current_streak, "streak_held")` when the day is not scheduled. Consider a `grace_days` parameter for soft resets. Cover the Mon/Wed/Fri cadence explicitly in unit tests.

---

### BUG-STREAK-002 — `compute_consecutive_streak` trusts naive UTC timestamps and has a concurrency race (Severity: Critical)

**Component:** `backend/src/services/streaks.py:31-72`

**Symptom:** Two concurrent `POST /completions` requests on the same local day, plus any user outside UTC, produce the wrong streak in two ways:
1. `_to_date(ts)` extracts the UTC date, so a 23:30 local + 00:15 local pair (same user day) can land on different UTC dates and be counted as a 2-day streak; conversely a 01:00 local completion followed by 23:00 same-day local can collapse into one UTC day and lose a day.
2. `compute_consecutive_streak` reads `GoalCompletion` rows with no row-level lock; two simultaneous writes both see `streak = N`, both write `streak = N+1` to any cached summary, and the true value diverges.

**Root cause:**
```python
def _to_date(ts: object) -> date_type:
    return ts.date() if hasattr(ts, "date") else date_type.fromisoformat(str(ts)[:10])

async def compute_consecutive_streak(session, goal_id, user_id) -> int:
    rows = await session.execute(
        select(GoalCompletion.timestamp, GoalCompletion.completed_units)
        .where(GoalCompletion.goal_id == goal_id, GoalCompletion.user_id == user_id)
        .order_by(col(GoalCompletion.timestamp).desc())
    )
    day_totals: dict[date_type, float] = {}
    for ts, units in rows:
        day = _to_date(ts)
        day_totals[day] = day_totals.get(day, 0.0) + units
```

**Fix:** Pass the user's timezone into `_to_date` and convert before extracting the date. For concurrency, either (a) make the streak a pure read-through projection computed from `GoalCompletion` on every GET (no cached value to race on), or (b) wrap the compute+persist pair in a `SELECT ... FOR UPDATE` on the parent row. Add a regression test that spawns two parallel `POST /completions` with `asyncio.gather` and asserts the final streak equals 1, not 2.

**Cross-references:** BUG-HABIT-006, BUG-DB-002.

---

## Summary table

| Bug ID          | Severity | Area                         |
|-----------------|----------|------------------------------|
| BUG-HABIT-001   | High     | Response leaks user_id        |
| BUG-HABIT-002   | Medium   | No input bounds / quota       |
| BUG-HABIT-003   | Medium   | IDOR side-channel / audit log |
| BUG-HABIT-004   | High     | Hard delete + cascade gap     |
| BUG-HABIT-005   | Medium   | N+1 on list endpoint          |
| BUG-HABIT-006   | High     | UTC day boundaries in stats   |
| BUG-HABIT-007   | Medium   | Completion rate semantics     |
| BUG-HABIT-008   | Low      | Date string round-tripping    |
| BUG-STREAK-001  | High     | Non-scheduled day resets      |
| BUG-STREAK-002  | Critical | TZ + concurrency in streak   |

---

## Suggested Remediation Order

1. **BUG-STREAK-002** (Critical) — Replace naive UTC date extraction with user-TZ-aware date arithmetic. Wrap streak mutations in a `SELECT ... FOR UPDATE` row lock (or an advisory lock keyed on habit_id) so concurrent completion POSTs serialize. Unit test with two parallel POSTs asserting the final streak is `+1`, not `+2`.
2. **BUG-HABIT-006** (High) — Pass the user's timezone into `compute_habit_stats`. Use `zoneinfo.ZoneInfo(user.timezone)` to localize each completion timestamp before `.date()` / `.weekday()`. Add a fixture test at UTC+14 and UTC-12 boundaries.
3. **BUG-STREAK-001** (High) — Introduce a "next expected day" helper that honors `notification_days`. Only reset the streak when the gap exceeds the cadence.
4. **BUG-HABIT-001** (High) — Define a `HabitResponse` DTO with `model_config = ConfigDict(from_attributes=True)` that omits `user_id`. Update every handler's `response_model=`. Pair fix with BUG-SCHEMA-001.
5. **BUG-HABIT-004** (High) — Introduce soft-delete (`deleted_at` column). Deletion sets the column, list endpoints filter it out. Pair with BUG-MODEL-002 (FK cascade rewrite).
6. **BUG-HABIT-002** (Medium) — Enforce `max_habits_per_user` at the router and add the `(user_id, lower(name))` unique index (pair with BUG-SCHEMA-004).
7. **BUG-HABIT-003 / -005** (Medium) — Normalize IDOR path: filter in `WHERE` to equalize timing, log `habit_access_denied` on rejections. Extend `HABIT_WITH_GOALS_AND_COMPLETIONS` loader options to cover every relationship the response DTO touches.
8. **BUG-HABIT-007 / -008** (Medium/Low) — Carry cadence into `_completion_rate`; cache date parsing once per call.

## Cross-References

- **BUG-SCHEMA-001** (HabitResponse leaks `user_id`) — router-side mirror is BUG-HABIT-001.
- **BUG-SCHEMA-004** (HabitCreate missing min/max bounds) — BUG-HABIT-002 is the router-layer pair.
- **BUG-SCHEMA-005** (JournalListResponse bespoke envelope) — same anti-pattern in BUG-HABIT-003 (unbounded list).
- **BUG-MODEL-002** (FK `user_id` no `ondelete`) — BUG-HABIT-004 hard-delete reveals this.
- **BUG-DB-002** (timestamp race on sessions) — thematic pair to BUG-STREAK-002.
- **BUG-AUTH-001** (dummy-token signup) — upstream of BUG-HABIT-005 (ownership check may see `user_id=0`).
- **BUG-NAV-001** (RootNavigator flips on null token) — client UI reacts to the 401s BUG-HABIT-005 emits.
