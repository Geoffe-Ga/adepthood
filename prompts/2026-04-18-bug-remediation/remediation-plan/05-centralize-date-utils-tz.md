# Prompt 05 — Centralize date/TZ utils; fix streak drift (Wave 3, parallelizable)

## Role
You are an engineer with scars from date/timezone bugs. You know that "today" is a user-local concept, that `datetime.utcnow()` silently fails on midnight boundaries, and that Postgres `timestamp` without time zone is a trap.

## Goal
Eliminate the five-bug UTC/local-drift family by introducing a single source of truth for "today in user's TZ" on both backend and frontend, storing the user's IANA timezone on the `User` row, and migrating `timestamp` columns to `timestamptz`.

Success criteria:

1. `User.timezone: str` (IANA, default `"UTC"`) added and populated from client on signup; editable via profile endpoint.
2. `backend/src/domain/dates.py` exports `today_in_tz(user) -> date`, `day_boundary_in_tz(user, dt) -> datetime` used everywhere streak / daily-completion math runs.
3. `frontend/src/utils/dateUtils.ts` exports `todayInUserTZ()`, `dayLabel(date, tz)`, `streakFromCompletions(dates, tz)` — all feature code migrated off inline `Date`/`Date.now()` day math.
4. Alembic migration flips `DateTime` → `TIMESTAMPTZ` on `user.*_at`, lockout tables, completion tables, practice sessions — every comparison-sensitive column.
5. Habit streak recomputes within a quarter-second of local midnight (no off-by-one); unit tests cover negative-offset TZ (Pacific/Pago_Pago, UTC-11) and positive (Pacific/Kiritimati, UTC+14).

## Context
Bug IDs:
- `prompts/2026-04-18-bug-remediation/09-habits-streaks.md` — **BUG-STREAK-002** (Critical; backend streak in UTC while user is local), **BUG-HABIT-006** (day labels in UTC).
- `prompts/2026-04-18-bug-remediation/10-goals-completions-groups.md` — **BUG-GOAL-004** (`_already_logged_today` uses server UTC midnight).
- `prompts/2026-04-18-bug-remediation/16-frontend-features-habits-journal.md` — **BUG-FE-HABIT-002** (UTC/local streak drift), **BUG-FE-HABIT-206** (`calculateHabitStartDate` UTC drift), **BUG-FE-HABIT-207** (`computeCurrentStreak` never compares to today).
- `prompts/2026-04-18-bug-remediation/06-backend-database-migrations.md` — **BUG-DB-002** (naive `DateTime` columns).

Files you will touch (expect ≤18): `backend/src/models/user.py`, new `backend/src/domain/dates.py`, `backend/src/routers/{habits,goals,practices}.py`, `backend/src/domain/{streaks,goals}.py`, new Alembic migration, new `frontend/src/utils/dateUtils.ts`, `frontend/src/features/Habits/{logic,components}/*.ts(x)`, tests.

## Output Format
Four atomic commits:

1. `feat(backend): add User.timezone + dates domain utils` — new column (nullable with default UTC), new `domain/dates.py`, migration; no call-site changes yet.
2. `fix(backend): compute streaks + daily completions in user TZ (BUG-STREAK-002, BUG-HABIT-006, BUG-GOAL-004)` — migrate domain logic + router usage; tests at DST boundary + negative/positive UTC offsets.
3. `fix(db): migrate DateTime → TIMESTAMPTZ on comparison-sensitive columns (BUG-DB-002)` — separate migration with reversible downgrade.
4. `fix(frontend): centralize dateUtils; migrate Habit screens (BUG-FE-HABIT-002, -206, -207)`.

## Examples

Backend helper:
```python
# backend/src/domain/dates.py
from zoneinfo import ZoneInfo
def today_in_tz(user: User) -> date:
    tz = ZoneInfo(user.timezone or "UTC")
    return datetime.now(tz).date()

def day_bounds_in_tz(user: User, day: date) -> tuple[datetime, datetime]:
    tz = ZoneInfo(user.timezone or "UTC")
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = start + timedelta(days=1)
    return start, end
```

Frontend helper:
```ts
// frontend/src/utils/dateUtils.ts
export function todayInUserTZ(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  // returns "YYYY-MM-DD" which sorts lexicographically
}
```

## Requirements
- `testing`: property-based or table-driven tests for TZ boundaries (DST spring-forward + fall-back, UTC-11, UTC+14, crossing year boundary).
- `max-quality-no-shortcuts`: no `# type: ignore[arg-type]` on `ZoneInfo`; add `tzdata` to requirements if missing on target platform.
- Do NOT use `pytz` — use stdlib `zoneinfo`.
- Migration must be reversible and concurrent-safe (`ALTER COLUMN ... TYPE TIMESTAMPTZ USING ... AT TIME ZONE 'UTC'`).
- On frontend, pass the user's TZ from auth context — do not pull from `Intl.DateTimeFormat().resolvedOptions()` at every call site.
- Do not touch Practice duration logic (Prompt 09 owns client-trusted-timestamps).
- `pre-commit run --all-files` before each commit.
- Safe to parallelize with Prompts 04, 06-10. Coordinate with Prompt 12 (backend feature remainders) — that prompt should not re-add naive datetimes.
