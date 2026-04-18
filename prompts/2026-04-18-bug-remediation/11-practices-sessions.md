# Practices, Sessions & Energy Bug Report — 2026-04-18

**Scope:** `backend/src/routers/practices.py` (84 LOC), `backend/src/routers/user_practices.py` (127 LOC), `backend/src/routers/practice_sessions.py` (105 LOC), `backend/src/routers/energy.py` (34 LOC), `backend/src/services/energy.py` (74 LOC). Covers practice submission and lifecycle, user-practice stage enrollment, session logging, and the energy planner.

**Total bugs: 10 — 0 Critical / 5 High / 4 Medium / 1 Low**

## Executive Summary

1. **Auth drift around user-submitted content (High).** BUG-PRACTICE-001: single-practice GET returns unapproved submissions regardless of approval status, so any authenticated user can view another user's draft submissions. BUG-PRACTICE-002: `submit_practice` calls `model_dump()` directly into the ORM constructor, so future schema fields (e.g. `approved`, `submitted_by_user_id`) can be set by the client.
2. **Stage-enrollment integrity (High).** BUG-PRACTICE-004: `create_user_practice` accepts any `(practice_id, stage_number)` pair without checking that `Practice.stage_number == payload.stage_number`. BUG-PRACTICE-005: TOCTOU race — two concurrent calls both pass the "no active practice for stage" check.
3. **Session write hygiene (High).** BUG-PRACTICE-006: `create_session` trusts client `timestamp` and `duration` with no bounds or backdate cap (parallels BUG-SCHEMA-008). BUG-PRACTICE-007: not idempotent — a retry/double-tap creates duplicate sessions.
4. **Unauthenticated energy endpoint + client-driven economy (Medium).** BUG-PRACTICE-010: `/v1/energy/plan` has no `get_current_user` dependency at all. The planner also trusts client-supplied `energy_cost`/`energy_return` per habit and has no list-length cap — O(n) loop over arbitrary n. Pairs with BUG-SCHEMA-007 and BUG-API-020.
5. **Timezone / rate-limit / status hygiene (Medium/Low).** BUG-PRACTICE-003: per-IP rate limit trivially bypassed via header (pairs with BUG-APP-006). BUG-PRACTICE-009: `week_count` uses local Monday against UTC timestamps. BUG-PRACTICE-008: `create_session` returns 200 where 201 is the contract.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-PRACTICE-001 | High | `routers/practices.py` | Practice detail IDOR via unapproved submissions |
| 2 | BUG-PRACTICE-002 | High | `routers/practices.py` | `submit_practice` `model_dump()` splats future fields |
| 3 | BUG-PRACTICE-004 | High | `routers/user_practices.py` | Client-payload `stage_number` not matched to `Practice` |
| 4 | BUG-PRACTICE-005 | High | `routers/user_practices.py` | TOCTOU on "single active practice per stage" |
| 5 | BUG-PRACTICE-006 | High | `routers/practice_sessions.py` | Client timestamp/duration trusted; no backdate cap |
| 6 | BUG-PRACTICE-003 | Medium | `routers/practices.py` | Per-IP rate limit trivially bypassed |
| 7 | BUG-PRACTICE-007 | Medium | `routers/practice_sessions.py` | Session POST not idempotent |
| 8 | BUG-PRACTICE-009 | Medium | `services/energy.py` | `week_count` uses local Monday vs. UTC timestamps |
| 9 | BUG-PRACTICE-010 | Medium | `routers/energy.py` + `services/energy.py` | Unauthenticated `/v1/energy/plan`; unbounded habit list |
| 10 | BUG-PRACTICE-008 | Low | `routers/practice_sessions.py` | `create_session` returns 200 instead of 201 |

---

# Fragment 11 — Practices Surface Bugs

Scope: practice CRUD, user-practice relationships, practice sessions, energy scoring.

Files audited:
- `backend/src/routers/practices.py`
- `backend/src/routers/user_practices.py`
- `backend/src/routers/practice_sessions.py`
- `backend/src/routers/energy.py`
- `backend/src/services/energy.py`

---

### BUG-PRACTICE-001 — Single-user practice detail IDOR via unapproved submissions (Severity: High)

**Component:** `backend/src/routers/practices.py:49-60` (`get_practice`)

**Symptom:** `GET /practices/{id}` only rejects records whose `approved` flag is false. A user who submits a practice and has it auto-stored (see `submit_practice`) can still read it at that URL, but there is no filter preventing a caller from enumerating IDs belonging to *other* users' unapproved submissions once an admin ever flips `approved=True`. Conversely, `list_practices` correctly filters by `approved=True` and `stage_number`, so detail is stricter than list — but detail leaks practices from arbitrary stages and, via the response, the `submitted_by_user_id` of whoever authored them.

**Root cause:**
```python
result = await session.execute(select(Practice).where(Practice.id == practice_id))
practice = result.scalars().first()
if practice is None or not practice.approved:
    raise not_found("practice")
return practice
```
No stage scoping, no check that the requester is the submitter when the practice is still pending, and the returned ORM instance is validated against `PracticeResponse` which (per BUG-SCHEMA-010) exposes `submitted_by_user_id`.

**Fix:** Either (a) require stage_number as a query parameter and reject cross-stage access, or (b) scope the query by `approved=True OR submitted_by_user_id == current_user`, and drop `submitted_by_user_id` from the response schema for non-owners.

**Cross-references:** BUG-SCHEMA-010.

---

### BUG-PRACTICE-002 — `submit_practice` accepts arbitrary `stage_number` and `approved`-adjacent fields via `model_dump()` (Severity: High)

**Component:** `backend/src/routers/practices.py:63-84` (`submit_practice`)

**Symptom:** The endpoint splats the entire client payload into the ORM constructor. If `PracticeCreate` ever gains or inherits a field the backend did not intend to accept (or currently exposes `stage_number`, `order`, `is_featured`, etc.), a user can set or manipulate it. There is no server-side validation that the submitted `stage_number` is within the 36-stage program, nor that title/description lengths are bounded at the router.

**Root cause:**
```python
practice = Practice(
    **payload.model_dump(),
    submitted_by_user_id=current_user,
    approved=False,
)
```
Whatever Pydantic accepts flows into the model. There is no explicit field allowlist.

**Fix:** Enumerate the fields explicitly (`title=payload.title, description=payload.description, stage_number=payload.stage_number, …`) so future schema drift cannot accidentally promote new columns into user-writable ones. Add a router-level guard `1 <= stage_number <= 36`.

**Cross-references:** BUG-SCHEMA-010.

---

### BUG-PRACTICE-003 — Rate limit on `submit_practice` is per-IP, trivially bypassed (Severity: Medium)

**Component:** `backend/src/routers/practices.py:63-84` (`submit_practice`)

**Symptom:** `@limiter.limit("5/minute")` throttles submissions, but the default `slowapi` key is the remote address. A single user can submit unlimited practices by rotating IPs (or via shared NAT, multiple legitimate users get throttled together). Because submissions seed an admin moderation queue (BUG-PRACTICE-002 compounds), spam can DoS moderators.

**Root cause:**
```python
@router.post("/", response_model=PracticeResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def submit_practice(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    payload: PracticeCreate,
    current_user: int = Depends(get_current_user),
    ...
```
The limiter has no `key_func` referencing `current_user`.

**Fix:** Supply `key_func=lambda req: req.state.user_id` (or equivalent) so the bucket is per-authenticated-user. Also add a global daily cap per user (e.g. 20/day) and log submission bursts for moderator review.

---

### BUG-PRACTICE-004 — `create_user_practice` does not verify the practice's `stage_number` matches the payload's `stage_number` (Severity: High)

**Component:** `backend/src/routers/user_practices.py:32-75` (`create_user_practice`)

**Symptom:** The caller can select a practice from stage 2 and record it under stage 17 by simply setting `payload.stage_number=17`. Because stage progression gating is downstream, this lets a user "complete" late stages with easy early-stage practices, corrupting the energy/streak economy.

**Root cause:**
```python
result = await session.execute(select(Practice).where(Practice.id == payload.practice_id))
practice = result.scalars().first()
if practice is None:
    raise not_found("practice")
if not practice.approved:
    raise bad_request("practice_not_approved")
# … no check that practice.stage_number == payload.stage_number …
user_practice = UserPractice(
    user_id=current_user,
    practice_id=payload.practice_id,
    stage_number=payload.stage_number,   # trusted from client
    start_date=datetime.now(UTC).date(),
)
```

**Fix:** Either drop `stage_number` from `UserPracticeCreate` and derive it from `practice.stage_number`, or assert `practice.stage_number == payload.stage_number` and raise `bad_request("stage_mismatch")` otherwise. Preferably the former — derivation is harder to misuse.

---

### BUG-PRACTICE-005 — Race condition: two concurrent `create_user_practice` calls both pass the "no active practice for stage" check (Severity: High)

**Component:** `backend/src/routers/user_practices.py:47-66` (`create_user_practice`)

**Symptom:** The dedupe check is a SELECT followed by an INSERT with no unique constraint and no `SELECT … FOR UPDATE`. Two near-simultaneous requests (e.g. a double-tap on mobile with flaky network, or a retry storm) can each observe no active practice and both commit a row, leaving the user with two active practices for the same stage. Subsequent `get_user_practice` lookups and energy planning then see inconsistent state.

**Root cause:**
```python
existing = await session.execute(
    select(UserPractice.id).where(
        UserPractice.user_id == current_user,
        UserPractice.stage_number == payload.stage_number,
        UserPractice.end_date.is_(None),
    )
)
if existing.scalar_one_or_none() is not None:
    raise bad_request("active_practice_exists_for_stage")

user_practice = UserPractice(...)
session.add(user_practice)
await session.commit()
```

**Fix:** Add a partial unique index on `(user_id, stage_number) WHERE end_date IS NULL` via an Alembic migration and translate the resulting `IntegrityError` to `bad_request("active_practice_exists_for_stage")`. The check-then-insert must be an atomic DB constraint, not a TOCTOU read.

**Cross-references:** BUG-STREAK-002.

---

### BUG-PRACTICE-006 — `create_session` trusts client timestamp and has no duration bounds or backdate cap (Severity: High)

**Component:** `backend/src/routers/practice_sessions.py:26-59` (`create_session`)

**Symptom:** `PracticeSessionCreate` exposes `timestamp` (see BUG-SCHEMA-008) and `duration_minutes`. The router passes these through without clamping. A user can backdate a session to any past date to retroactively "complete" missed practice days (gaming the streak system) or post a session with `duration_minutes=999999` or a negative value, poisoning the week-count query and any future analytics.

**Root cause:**
```python
practice_session = PracticeSession(
    user_id=current_user,
    user_practice_id=payload.user_practice_id,
    duration_minutes=payload.duration_minutes,
    reflection=payload.reflection,
)
session.add(practice_session)
await session.commit()
```
No assertions on `duration_minutes` (e.g. `0 < duration_minutes <= 600`), no handling of `payload.timestamp`, no comparison against `user_practice.start_date`.

**Fix:** At the router, clamp `duration_minutes` to `[1, 600]` and reject otherwise. If the schema keeps `timestamp`, assert `user_practice.start_date <= timestamp <= now + 5min` and reject anything older than e.g. 24h. Drop client `timestamp` from the schema entirely if there is no legitimate offline-submission use case.

**Cross-references:** BUG-SCHEMA-008.

---

### BUG-PRACTICE-007 — `create_session` is not idempotent — double-submit duplicates the session (Severity: Medium)

**Component:** `backend/src/routers/practice_sessions.py:26-59` (`create_session`)

**Symptom:** Unlike the energy plan endpoint (which honours `X-Idempotency-Key`), session creation has no dedupe. A flaky mobile client retrying a POST after a network blip will create two sessions with identical `user_practice_id`, `duration_minutes`, and `reflection`. Users see inflated week counts and streaks.

**Root cause:**
```python
@router.post("/", response_model=PracticeSessionResponse)
async def create_session(
    payload: PracticeSessionCreate,
    current_user: int = Depends(get_current_user),
    ...
) -> PracticeSession:
    ...
    session.add(practice_session)
    await session.commit()
```
No `X-Idempotency-Key` header, no dedupe window, no uniqueness constraint.

**Fix:** Accept an optional `X-Idempotency-Key` header and cache the response keyed by `(user_id, key)` for e.g. 10 minutes in the same TTL cache pattern the energy service uses. Alternatively (or additionally) reject inserts that duplicate an existing `(user_id, user_practice_id, timestamp_truncated_to_minute)` row.

---

### BUG-PRACTICE-008 — Missing response status code on `create_session` — 200 instead of 201 (Severity: Low)

**Component:** `backend/src/routers/practice_sessions.py:26` (`create_session` decorator)

**Symptom:** The decorator omits `status_code=status.HTTP_201_CREATED` and defaults to 200. Every other POST on this surface (`submit_practice`, `create_user_practice`) correctly returns 201. Downstream clients and log-based monitoring (e.g. alerting on non-2xx) see inconsistent semantics for resource creation.

**Root cause:**
```python
@router.post("/", response_model=PracticeSessionResponse)
async def create_session(
    payload: PracticeSessionCreate,
    ...
```
No `status_code=status.HTTP_201_CREATED`.

**Fix:** Add `status_code=status.HTTP_201_CREATED` to the decorator.

---

### BUG-PRACTICE-009 — `week_count` uses local Monday but session timestamps are UTC — off-by-one for non-UTC users (Severity: Medium)

**Component:** `backend/src/routers/practice_sessions.py:90-105` (`week_count`)

**Symptom:** The week is computed from `datetime.now(UTC).weekday()` and truncated to UTC midnight. Users in UTC-8 (California, e.g. Sunday 6pm local = Monday 02:00 UTC) see their Sunday-evening session land in "next week" server-side. The dashboard "sessions this week" tile will read 0 on Sunday evenings and reset at 4pm local Sunday instead of at the user's local Monday.

**Root cause:**
```python
now = datetime.now(UTC)
start_of_week = now - timedelta(days=now.weekday())
start_of_week = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
statement = select(func.count()).where(
    PracticeSession.user_id == current_user,
    PracticeSession.timestamp >= start_of_week,
)
```

**Fix:** Accept an `X-User-Timezone` header (IANA zone) or persist the user's timezone at signup. Compute week boundaries in the user's local zone, then convert back to UTC for the DB predicate. Document the program's canonical week definition (Mon 00:00 local vs. ISO week) in `domain/streaks` and reuse here.

---

### BUG-PRACTICE-010 — Energy plan has no list-length cap; `generate_plan` runs on payload-sized loop unbounded (Severity: Medium)

**Component:** `backend/src/routers/energy.py:18-34` and `backend/src/services/energy.py:35-53` (`build_energy_response`)

**Symptom:** `EnergyPlanRequest.habits` has no server-side length bound. A client can post 100k habits; `generate_plan` will iterate over them (and any quadratic pair-scoring inside `domain.energy`) on the thread-pool executor. One request can pin a worker thread for seconds, exhausting `asyncio.to_thread`'s default executor (capped at `min(32, cpu+4)`), starving other requests. There is also no ownership check that `habit_id`s in the payload belong to the caller — the service trusts client-supplied `energy_cost`/`energy_return` per habit.

**Root cause:**
```python
# routers/energy.py
response = await asyncio.to_thread(get_or_generate_plan, payload, x_idempotency_key)

# services/energy.py
def build_energy_response(payload: EnergyPlanRequest) -> EnergyPlanResponse:
    habits = [DomainHabit(**h.model_dump()) for h in payload.habits]
    try:
        plan, reason = generate_plan(habits, payload.start_date)
```
No `len(payload.habits)` assertion, no re-hydration of habit costs/returns from the DB, no `current_user` dependency on the endpoint at all — the route accepts anonymous traffic (`get_current_user` is not in the signature).

**Fix:** Add `current_user: int = Depends(get_current_user)` to `create_plan`. Validate `1 <= len(payload.habits) <= 50` in the schema (or at the router). For each submitted habit, load the canonical cost/return from the DB via `habit_id` scoped to `user_id` and ignore client-supplied economy values — trust the stored row, not the request. Log + 400 on any `habit_id` the caller does not own.

**Cross-references:** BUG-SCHEMA-007, BUG-API-020.

---

## Suggested Remediation Order

1. **BUG-PRACTICE-010** (Medium but treat as High) — Add `current_user: int = Depends(get_current_user)` to `/v1/energy/plan`. Load `energy_cost`/`energy_return` server-side from `Habit.user_id == current_user`; reject client-supplied values. Cap the habit list at e.g. 200.
2. **BUG-PRACTICE-001** (High) — `GET /practices/{id}` should filter `approved=True OR submitted_by_user_id = current_user`. Add an ownership-aware query.
3. **BUG-PRACTICE-002** (High) — Replace `Practice(**payload.model_dump())` with explicit kwargs. Set `submitted_by_user_id=current_user` and `approved=False` server-side; ignore any client-sent values for those fields.
4. **BUG-PRACTICE-004** (High) — Load `Practice` by `practice_id` and assert `Practice.stage_number == payload.stage_number`. Return 400 on mismatch.
5. **BUG-PRACTICE-005** (High) — Add a unique index on `(user_id, stage_number)` where `active=True`. Catch `IntegrityError` and translate.
6. **BUG-PRACTICE-006** (High) — Drop client `timestamp` (stamp `datetime.now(UTC)` server-side) or clamp to `ge=now()-24h, le=now()+5m`. Validate `duration_seconds` with `ge=1, le=86400`.
7. **BUG-PRACTICE-007** (Medium) — Require an `idempotency_key` header or dedupe on `(user_practice_id, timestamp_minute)`.
8. **BUG-PRACTICE-003** (Medium) — Move rate-limit key from IP to `user_id`. Pair with BUG-APP-006 fix.
9. **BUG-PRACTICE-009** (Medium) — Use `ZoneInfo(user.timezone)` to localize session timestamps before `isoweek`.
10. **BUG-PRACTICE-008** (Low) — Declare `status_code=status.HTTP_201_CREATED` on the decorator.

## Cross-References

- **BUG-SCHEMA-007** (EnergyPlanRequest trusts client cost/return) — router-layer mirror is BUG-PRACTICE-010.
- **BUG-SCHEMA-008** (PracticeSessionCreate.timestamp backdateable) — router-layer mirror is BUG-PRACTICE-006.
- **BUG-SCHEMA-010** (PracticeResponse leaks `submitted_by_user_id`) — ancillary to BUG-PRACTICE-001.
- **BUG-API-020** (frontend lenient EnergyPlanRequest) — client-side mirror of BUG-PRACTICE-010.
- **BUG-APP-006** (rate-limit trust of `X-Forwarded-For`) — pairs with BUG-PRACTICE-003.
- **BUG-STREAK-002 / BUG-HABIT-006 / BUG-GOAL-004** (UTC day boundaries) — BUG-PRACTICE-009 is the practice-side mirror.
- **BUG-GOAL-001** (TOCTOU duplicate completion) — same pattern as BUG-PRACTICE-005 (TOCTOU on stage uniqueness) and BUG-PRACTICE-007 (no session idempotency).
- **BUG-AUTH-018** (no admin gating) — BUG-PRACTICE-002 `approved=True` escalation cannot be safely reviewed until admin identity exists.
