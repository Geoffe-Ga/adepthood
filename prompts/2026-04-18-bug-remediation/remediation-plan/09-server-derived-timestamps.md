# Prompt 09 — Server-derived timestamps + client-value validation (Wave 3, parallelizable)

## Role
You are a backend engineer who assumes the client clock is lying, its battery-saver throttled `setInterval`, and its JS `Date.now()` may have been frozen by the OS when the app was backgrounded. You derive durations from server-stamped `started_at`/`ended_at` ISO strings and validate every incoming number.

## Goal
Stop trusting client-sent durations and timestamps. Move duration computation to the server. Add Pydantic bounds on every numeric field that represents time, energy, or count.

Success criteria:

1. `POST /practice/session` accepts `started_at: datetime` and `ended_at: datetime` (ISO, with TZ); duration is computed server-side as `ended_at - started_at`. Reject if `started_at > ended_at`, if `ended_at > now + 60s`, or if duration > 8h.
2. Client no longer sends `duration_seconds`. If present, backend ignores.
3. `EnergyPlanRequest` clamps each energy value to its documented range.
4. `PracticeSessionCreate.timestamp` no longer backdateable beyond a documented window (e.g., 24h).
5. Frontend practice timer uses a monotonic wall-clock source (e.g., `performance.now()` + `Date` sync, or just `startedAt = new Date().toISOString()` + display-only countdown) — not `setInterval` tick accumulation.
6. Login email lowercased client-side before POST (BUG-FE-AUTH-015) so the backend receives canonical form.

## Context
- `prompts/2026-04-18-bug-remediation/11-practices-sessions.md` — **BUG-PRACTICE-006** (client timestamp/duration trusted; no backdate cap).
- `prompts/2026-04-18-bug-remediation/07-backend-models-schemas.md` — **BUG-SCHEMA-007** (`EnergyPlanRequest` trusts client energy values), **BUG-SCHEMA-008** (`PracticeSessionCreate.timestamp` backdateable).
- `prompts/2026-04-18-bug-remediation/17-frontend-features-practice-course-map.md` — **BUG-FE-PRACTICE-101** (Critical; background drift on `setInterval`), **BUG-FE-PRACTICE-004** (client duration unchecked; zero / fractional allowed), **BUG-FE-PRACTICE-105** (`onComplete` trusts client clock).
- `prompts/2026-04-18-bug-remediation/02-frontend-auth-context.md` — **BUG-FE-AUTH-015** (login email not lowercased).

Files you will touch (expect ≤12): `backend/src/routers/practices.py`, `backend/src/schemas/{practice,energy}.py`, `backend/src/domain/practice.py`, `frontend/src/features/Practice/components/Timer.tsx`, `frontend/src/features/Practice/logic/session.ts`, `frontend/src/features/Auth/LoginScreen.tsx`.

## Output Format
Four atomic commits:

1. `feat(backend): derive practice duration server-side; accept started_at/ended_at (BUG-PRACTICE-006, BUG-SCHEMA-008)`.
2. `fix(backend): clamp EnergyPlanRequest values (BUG-SCHEMA-007)`.
3. `fix(frontend): use monotonic wall-clock for practice timer; send ISO timestamps (BUG-FE-PRACTICE-101, -004, -105)`.
4. `fix(frontend): lowercase login email client-side (BUG-FE-AUTH-015)`.

## Examples

Schema with bounds:
```python
class PracticeSessionCreate(BaseModel):
    practice_id: int
    stage_number: int = Field(..., ge=1, le=36)
    started_at: datetime  # must be TZ-aware; validator below
    ended_at: datetime

    @model_validator(mode="after")
    def check_times(self) -> "PracticeSessionCreate":
        if self.started_at.tzinfo is None or self.ended_at.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware")
        now = datetime.now(tz=self.ended_at.tzinfo)
        if self.ended_at < self.started_at:
            raise ValueError("ended_at must be >= started_at")
        if self.ended_at > now + timedelta(seconds=60):
            raise ValueError("ended_at in future")
        if now - self.started_at > timedelta(hours=24):
            raise ValueError("session too far in past")
        if self.ended_at - self.started_at > timedelta(hours=8):
            raise ValueError("session duration unrealistic")
        return self
```

Frontend timer:
```tsx
// Display the elapsed from a monotonic start; submit ISO timestamps.
const startedAtRef = useRef<Date | null>(null);
const startSession = () => { startedAtRef.current = new Date(); };
const endSession = () => {
  const endedAt = new Date();
  void api.practice.submit({
    practiceId,
    startedAt: startedAtRef.current!.toISOString(),
    endedAt: endedAt.toISOString(),
  });
};
// Display tick uses setInterval purely for the count-up UI; never submitted.
```

## Requirements
- `max-quality-no-shortcuts`: every incoming number gets a Pydantic bound. No defensive `if value > 0` checks — use `Field(gt=0)`.
- Backend must use `datetime.now(timezone.utc)` for comparisons, not `datetime.utcnow()`.
- Preserve backward compat for one release if the client cannot update atomically: accept both `duration_seconds` and `started_at/ended_at`, log a warning when the former is used, plan deletion in the next version.
  - If no such compat window is needed, delete outright.
- Frontend: pause/resume should not corrupt the reported duration — either clamp to "wall-clock total" or disallow pause submission.
- `pre-commit run --all-files` before each commit; coverage >=90%.
- Parallelizable with 04-08, 10. Coordinate with Prompt 12 on practice router — Prompt 09 owns the timestamp-related diff; Prompt 12 owns the rest.
