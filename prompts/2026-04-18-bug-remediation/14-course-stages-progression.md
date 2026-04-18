# Course, Stages & Progression Bug Report — 2026-04-18

**Scope:** `backend/src/routers/course.py` (282 LOC), `backend/src/routers/stages.py` (231 LOC), `backend/src/domain/stage_progress.py` (265 LOC), `backend/src/domain/course.py` (45 LOC). Covers the course content surface (stage-scoped content listing, per-item read tracking, course-wide progress) and the stage progression gate (unlock chain, advancement writes, aggregate progress).

**Total bugs: 10 — 1 Critical / 4 High / 4 Medium / 1 Low**

## Executive Summary

1. **Progression gate bypass on corrupted state (Critical).** BUG-STAGE-001: `is_stage_unlocked` only checks `N-1 in completed_stages` rather than the full prerequisite chain — a corrupted `completed_stages=[35]` unlocks stage 36 directly. Compounded by BUG-SCHEMA-006 (client-writable `current_stage`) — together they are a direct path to "skip to stage 36."
2. **Redundant state guaranteed to drift (High).** BUG-STAGE-002: `current_stage` and `completed_stages` are both persisted. Unlock checks read one field while the display reads the other, so partial writes or mid-session crashes leave the UI and the gate disagreeing.
3. **Write-path races (High).** BUG-STAGE-003: `SELECT ... FOR UPDATE` locks zero rows on the first-ever advance, so concurrent create-path INSERTs can produce duplicate `StageProgress` rows. Cross-links BUG-PRACTICE-005 (same TOCTOU pattern on stage-scoped create). BUG-COURSE-002: `mark_content_read` is a check-then-insert with no DB-level unique constraint on `(user_id, content_id)`.
4. **Content-unlock leaks (High/Medium).** BUG-COURSE-001: `list_stage_content` skips the `_check_stage_unlocked` call its sibling endpoints make — titles and `release_day` for locked stages leak (only `url` is nulled). BUG-COURSE-003: `get_course_progress` leaks `total_items` and `next_unlock_day` for future stages. BUG-COURSE-004: 404-before-403 IDOR oracle on `content_id`.
5. **Correctness + performance (Medium/Low).** BUG-STAGE-004: `list_stages` is N+M (~147 queries at 36 stages). BUG-STAGE-005: `overall_progress` averages 2 of 3 tracked metrics; `course_items_completed` is returned but silently excluded. BUG-COURSE-005: `compute_days_elapsed` silently clamps future `stage_started_at` to 0, auto-unlocking day-0 content on clock skew.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-STAGE-001 | Critical | `domain/stage_progress.py` | Unlock trusts single predecessor; chain-skip exposure |
| 2 | BUG-STAGE-002 | High | `domain/stage_progress.py` | `current_stage` vs `completed_stages` drift |
| 3 | BUG-STAGE-003 | High | `routers/stages.py` | First-advance create path not row-locked |
| 4 | BUG-COURSE-001 | High | `routers/course.py` | `list_stage_content` skips unlock check |
| 5 | BUG-COURSE-002 | High | `routers/course.py` | `mark_content_read` check-then-insert race |
| 6 | BUG-STAGE-004 | Medium | `routers/stages.py` | `list_stages` N+M queries |
| 7 | BUG-STAGE-005 | Medium | `domain/stage_progress.py` | `overall_progress` silently drops metric |
| 8 | BUG-COURSE-003 | Medium | `routers/course.py` | `get_course_progress` leaks future-stage metadata |
| 9 | BUG-COURSE-004 | Medium | `routers/course.py` | IDOR oracle on `content_id` (404 vs 403) |
| 10 | BUG-COURSE-005 | Low | `domain/course.py` | `compute_days_elapsed` clamps future timestamps silently |

---

## Course router & domain — `routers/course.py`, `domain/course.py`

### BUG-COURSE-001 — `list_stage_content` does not verify stage unlock (Severity: High)

**Component:** `backend/src/routers/course.py:102-140`

**Symptom:** Any authenticated user can enumerate the full content list (titles, `content_type`, `release_day`) of *any* stage, including stages they have not unlocked. `filter_content_for_user` only nulls the `url` field for locked items — `title` and `release_day` still leak, exposing upcoming curriculum and pacing secrets for stages the user has not reached.

**Root cause:**
```python
@router.get("/stages/{stage_number}/content", response_model=None)
async def list_stage_content(
    stage_number: int,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    pagination: PaginationParams = Depends(),
) -> Page[ContentItemResponse] | list[ContentItemResponse]:
    stage = await _get_stage_by_number(session, stage_number)
    # No _check_stage_unlocked() — unlike get_content_item / mark_content_read
    result = await session.execute(
        select(StageContent)
        .where(StageContent.course_stage_id == stage.id)
        ...
```

**Fix:** Add `await _check_stage_unlocked(session, current_user, stage_number)` right after resolving the stage, mirroring `get_content_item` (line 164) and `mark_content_read` (line 205). Alternatively, if locked-stage previews are a product requirement, redact `title` and `release_day` in `filter_content_for_user` for locked items — not just `url`. Add a regression test that asserts 403 when listing content for a future stage.

**Cross-references:** BUG-SCHEMA-010 (response leak of internal fields), BUG-COURSE-003.

---

### BUG-COURSE-002 — `mark_content_read` has a check-then-insert race (Severity: High)

**Component:** `backend/src/routers/course.py:185-233`

**Symptom:** The "idempotent" behavior is implemented by a SELECT followed by an INSERT with no transactional guard. Two concurrent POSTs (double-tap on mobile, retries, parallel clients) both observe `existing is None`, both call `session.add(...)`, and both commit — producing duplicate `ContentCompletion` rows for the same `(user_id, content_id)`. Downstream, `read_items = len(read_ids)` in `get_course_progress` collapses duplicates via `set`, but row counts, audit logs, and any future analytics are corrupted.

**Root cause:**
```python
existing = existing_result.scalars().first()
if existing is not None:
    return ContentCompletionResponse(...)

completion = ContentCompletion(user_id=current_user, content_id=content_id)
session.add(completion)
await session.commit()
await session.refresh(completion)
```

**Fix:** Add a DB-level unique constraint on `ContentCompletion(user_id, content_id)` via an Alembic migration, then use `INSERT ... ON CONFLICT DO NOTHING` (PostgreSQL `on_conflict_do_nothing` from `sqlalchemy.dialects.postgresql.insert`) and re-SELECT to return the canonical row. This closes the race at the database layer rather than trusting application-level check-then-write. Wrap the whole operation in a single transaction.

**Cross-references:** BUG-PRACTICE-004 (similar idempotency gap in sessions).

---

### BUG-COURSE-003 — `get_course_progress` leaks stage metadata without unlock check (Severity: Medium)

**Component:** `backend/src/routers/course.py:248-282`

**Symptom:** The endpoint checks only `stage_exists`, never `is_stage_unlocked`. An authenticated user can GET `/course/stages/36/progress` and receive `total_items` and `next_unlock_day` for stages far beyond their `current_stage`. Combined with BUG-COURSE-001 this lets a user reconstruct the full 36-stage drip schedule without ever unlocking a stage.

**Root cause:**
```python
async def get_course_progress(stage_number: int, ...) -> CourseProgressResponse:
    if not await stage_exists(session, stage_number):
        raise not_found("stage")
    stage = await _get_stage_by_number(session, stage_number)
    result = await session.execute(
        select(StageContent).where(StageContent.course_stage_id == stage.id)
    )
    items = list(result.scalars().all())
    ...  # returns total_items + next_unlock_day unconditionally
```

Also note the redundant `stage_exists` + `_get_stage_by_number` — both hit the DB, and `_get_stage_by_number` already raises 404, so the first call is dead weight (N+1 micro-regression).

**Fix:** Add `await _check_stage_unlocked(session, current_user, stage_number)` after resolving the stage. Drop the duplicate `stage_exists` call. Add a test asserting 403 when requesting progress for a locked stage.

**Cross-references:** BUG-COURSE-001, BUG-SCHEMA-006 (`current_stage` unbounded means `is_stage_unlocked` must be defensive against nonsense values).

---

### BUG-COURSE-004 — IDOR via `content_id` enumeration (Severity: Medium)

**Component:** `backend/src/routers/course.py:143-182`, `backend/src/routers/course.py:185-205`

**Symptom:** Both `GET /course/content/{content_id}` and `POST /course/content/{content_id}/mark-read` return `404 not_found("content")` *before* checking stage access, but return `403 forbidden("stage_locked")` after. An attacker iterating `content_id = 1..N` can distinguish valid-but-locked content from nonexistent IDs, revealing the total count of content rows and (when paired with timing) the stage boundaries. This is a classic IDOR disclosure oracle.

**Root cause:**
```python
result = await session.execute(select(StageContent).where(StageContent.id == content_id))
item = result.scalars().first()
if item is None:
    raise not_found("content")            # distinct from...
...
await _check_stage_unlocked(session, current_user, stage.stage_number)  # ...this 403
```

**Fix:** Return the same status (404) for both "content does not exist" and "content exists but stage is locked" when the user has not unlocked the stage — i.e. collapse the 403 branch into a 404 to avoid leaking existence. Alternatively, join `StageContent` to `CourseStage` in a single query and make the existence check stage-scoped: `WHERE content.id = :id AND stage.stage_number <= :user_current_stage`. This also fixes the N+1 (two sequential queries per request).

**Cross-references:** BUG-PRACTICE-004 (`stage_number` mismatch — similar IDOR surface).

---

### BUG-COURSE-005 — `compute_days_elapsed` silently masks future `stage_started_at` (Severity: Low)

**Component:** `backend/src/domain/course.py:9-16`

**Symptom:** When `stage_started_at` is in the future — possible via clock skew between app servers, an admin backfill with a wrong timestamp, or a migration bug — `delta.days` is negative and `max(0, delta.days)` returns `0`. The user then sees all `release_day == 0` content as unlocked on a stage they have not legitimately started. There is no logging, no assertion, and no telemetry on this path. The same function also uses `delta.days` which *floors toward negative infinity* for negative timedeltas in Python, so a future-dated start 1 second ahead yields `-1`, not `0`, further inflating the mask.

**Root cause:**
```python
def compute_days_elapsed(stage_started_at: datetime) -> int:
    now = datetime.now(UTC)
    if stage_started_at.tzinfo is None:
        stage_started_at = stage_started_at.replace(tzinfo=UTC)
    delta = now - stage_started_at
    return max(0, delta.days)  # silently clamps impossible/negative states
```

**Fix:** Detect the `delta.total_seconds() < 0` case explicitly, log a warning with the user/stage IDs, and either raise a domain error or clamp to `0` with an audit trail — do not silently unlock content. Add a unit test for `stage_started_at > now`. Consider also guarding against `stage_started_at` that is absurdly far in the past (e.g. > 365 days) as a data-integrity smell.

**Cross-references:** BUG-SCHEMA-006 (`StageProgressUpdate.current_stage` unbounded — same class of "trust the DB" defect).


---

## Stages router & progression domain — `routers/stages.py`, `domain/stage_progress.py`

# Fragment 14b — Stages & Progression Bugs

Scope: `backend/src/routers/stages.py` + `backend/src/domain/stage_progress.py`.

---

### BUG-STAGE-001 — Unlock check trusts a single predecessor entry, enabling skip-exposure if `completed_stages` is ever corrupted (Severity: Critical)

**Component:** `backend/src/domain/stage_progress.py:46-58`

**Symptom:** `is_stage_unlocked` returns `True` for stage N whenever `N-1` appears
anywhere in `completed_stages`, without verifying that stages `1..N-2` were also
completed. If `completed_stages` is ever written to directly (admin tool, data
migration, Alembic backfill, or the drift noted in BUG-STAGE-002) with a value
like `[35]`, the user immediately gains access to stage 36 content, history, and
progress endpoints without having progressed through stages 1-34.

**Root cause:**
```python
def is_stage_unlocked(stage_number: int, progress: StageProgress | None) -> bool:
    if stage_number == _STAGE_1:
        return True
    if progress is None:
        return False
    return (stage_number - 1) in (progress.completed_stages or [])
```

**Fix:** Verify the full prerequisite chain, not just the immediate predecessor.
Require `set(range(1, stage_number)).issubset(progress.completed_stages or [])`,
or — better — derive unlock status from `progress.current_stage` as the single
source of truth (`stage_number <= progress.current_stage`) and stop relying on
the denormalized `completed_stages` list for authorization decisions. Add a
property-based test that enumerates malformed `completed_stages` values and
asserts every gap denies access.

**Cross-references:** BUG-SCHEMA-006 (the schema-level bound is necessary but not
sufficient; this is the server-side chain check that BUG-SCHEMA-006 references).

---

### BUG-STAGE-002 — `current_stage` and `completed_stages` stored redundantly, guaranteed to drift (Severity: High)

**Component:** `backend/src/routers/stages.py:196-198`; model shape in
`models/stage_progress.py`.

**Symptom:** Two fields encode the same information: `current_stage` (scalar)
and `completed_stages` (list). The update handler recomputes `completed_stages`
from `current_stage` on every write (`list(range(1, payload.current_stage))`),
so any direct DB write, partial migration, or future endpoint that touches one
field without the other produces an inconsistent record. Unlock decisions
(BUG-STAGE-001) read `completed_stages` while display logic reads
`current_stage`, so drift silently flips users between "unlocked" and "locked"
for the same stage depending on which code path runs.

**Root cause:**
```python
completed = list(range(1, payload.current_stage))
existing.current_stage = payload.current_stage
existing.completed_stages = completed
existing.stage_started_at = datetime.now(UTC)
session.add(existing)
await session.commit()
```

**Fix:** Drop `completed_stages` from the persisted schema. It is a pure
function of `current_stage` under the "forward-only, no skipping" invariant, so
compute it on read (in `StageProgressRecord` / `StageResponse` serializers) and
delete the column via an Alembic migration. If legacy clients expect the list
shape on the wire, keep it in the response DTO but remove the stored column.

**Cross-references:** BUG-STAGE-001.

---

### BUG-STAGE-003 — Create path on `PUT /stages/progress` is not row-locked; concurrent first-advance POSTs can create duplicate StageProgress rows (Severity: High)

**Component:** `backend/src/routers/stages.py:190, 214-224`

**Symptom:** `get_user_progress_for_update` issues `SELECT … FOR UPDATE`, but a
`FOR UPDATE` clause locks *rows that matched*. When the user has no existing
progress, the SELECT returns zero rows and therefore locks nothing. Two
concurrent "start at stage 1" requests both read `existing is None`, both fall
through to the `INSERT`, and both commit. If the table lacks a
`UNIQUE(user_id)` constraint the user ends up with two `StageProgress` rows —
subsequent `get_user_progress` uses `.first()` and returns a non-deterministic
one, corrupting downstream reads.

**Root cause:**
```python
existing = await get_user_progress_for_update(session, current_user)
if existing is not None:
    ...
if payload.current_stage != 1:
    raise bad_request("must_start_at_stage_one")
progress = StageProgress(user_id=current_user, current_stage=1, completed_stages=[])
session.add(progress)
await session.commit()
```

**Fix:** Add a `UNIQUE(user_id)` constraint on `stage_progress` (via Alembic) so
the second INSERT fails with `IntegrityError`; catch it and retry the read path.
Alternatively, use `INSERT … ON CONFLICT (user_id) DO NOTHING RETURNING *` so
the race collapses to a single row deterministically. Either way, add a
concurrency test that issues N parallel first-advance requests and asserts
exactly one row exists.

**Cross-references:** BUG-PRACTICE-005 (same TOCTOU class — "uniqueness by
SELECT-then-INSERT" pattern without a DB-level uniqueness guarantee).

---

### BUG-STAGE-004 — `list_stages` issues N+M queries per request and leaks unlock state shape enabling enumeration (Severity: Medium)

**Component:** `backend/src/routers/stages.py:71-97, 41-68`

**Symptom:** The comment at line 82-84 acknowledges "N+M round-trip (one query
per metric per stage)" as acceptable at N=10, but the roadmap scales to 36
stages. Each stage triggers `compute_stage_progress`, which runs 3 separate
aggregate queries (`_compute_habits_progress` issues 2, plus the practice-count
query in `compute_stage_progress`, plus `_compute_course_items_completed`) — so
a single GET `/stages` fires `3 + 4*36 = 147` queries when fully populated. The
`is_unlocked` boolean is returned for every stage, so a client can trivially
enumerate the user's unlock frontier without any rate limiting.

**Root cause:**
```python
responses = [
    await _build_stage_response(s, session, current_user, progress)
    for s in stages
]
# _build_stage_response → compute_stage_progress → 3 aggregate queries per stage
```

**Fix:** Batch the progress computation across all stages in one pass: a single
`GROUP BY stage_number` aggregate per metric returning `{stage_number: value}`,
then zip into responses. Add a Redis (or in-process LRU) cache keyed on
`(user_id, last_progress_mtime)` with a 60s TTL — invalidated on the
`PUT /progress` path. Coverage: assert that `list_stages` executes O(1) queries
regardless of stage count via a query-count fixture.

**Cross-references:** none.

---

### BUG-STAGE-005 — `overall_progress` averages 2 of 3 tracked metrics; `course_items_completed` is returned but silently excluded (Severity: Medium)

**Component:** `backend/src/domain/stage_progress.py:128-141`

**Symptom:** `compute_stage_progress` computes three metrics (`habits_progress`,
`practice_count`, `course_items`) and returns all three in the response DTO,
but the `overall_progress` rollup divides by a hardcoded `divisor = 2` and
ignores `course_items` entirely. Users who complete course content but no
practices see their stage-progress bar stuck at ≤50% even when they've finished
every lesson. The conditional `if divisor > 0 else 0.0` on line 134 is also
dead — `divisor` is a literal `2`.

**Root cause:**
```python
habits_progress = await _compute_habits_progress(session, user_id, stage_number)
course_items = await _compute_course_items_completed(session, user_id, stage_number)

total = habits_progress + (1.0 if practice_count > 0 else 0.0)
divisor = 2
overall = total / divisor if divisor > 0 else 0.0
```

**Fix:** Include all three metrics in the rollup. Either compute
`course_items_progress = completed / total_content_items_for_stage` (needs a
count query against `StageContent`) and average all three, or document
explicitly that `overall_progress` is habits+practices only and rename the
field to match. Remove the dead `if divisor > 0` branch. Add a test that
asserts 100% completion across all three metrics produces `overall_progress ==
1.0`.

**Cross-references:** BUG-PRACTICE-004 (stage_number mismatch between
`UserPractice.stage_number` int and `Habit.stage` string — this file uses both
conventions on lines 66 and 123, compounding the risk).

---

---

## Suggested Remediation Order

1. **BUG-STAGE-001 (Critical)** — Replace `N-1 in completed_stages` with full prerequisite-chain validation (all stages `1..N-1` completed). Combine with the BUG-SCHEMA-006 fix (server-side `current_stage` derivation) to close the "skip to stage 36" path.
2. **BUG-COURSE-002 (High)** — Add a DB-level unique constraint on `(user_id, content_id)` in `ContentRead`; rely on `IntegrityError` to collapse the check-then-insert race.
3. **BUG-STAGE-003 (High)** — Convert the first-advance create path to an INSERT-on-conflict pattern (unique `(user_id)` on `StageProgress`) so concurrent first advances merge atomically.
4. **BUG-STAGE-002 (High)** — Treat `completed_stages` as the source of truth; derive `current_stage` in a read-only computed property rather than persisting it.
5. **BUG-COURSE-001 (High)** — Factor `_check_stage_unlocked` into a shared dependency and call it from `list_stage_content`; strip `title` and `release_day` for locked stages, not just `url`.
6. **BUG-COURSE-003 (Medium)** — Gate `total_items` / `next_unlock_day` in `get_course_progress` on unlock status; return aggregate counts only for stages the user has access to.
7. **BUG-COURSE-004 (Medium)** — Normalize 404/403 ordering in `mark_content_read` / `get_content`: always resolve the content row first, then authorize; return 403 for any cross-user access rather than leaking existence via 404.
8. **BUG-STAGE-004 (Medium)** — Replace the N+M per-stage query loop with a single `SELECT ... JOIN` or aggregation grouped by `stage_number`.
9. **BUG-STAGE-005 (Medium)** — Average all three tracked metrics in `overall_progress` (or document the exclusion); include `course_items_completed` in the denominator.
10. **BUG-COURSE-005 (Low)** — Raise an explicit error (or return `None`) when `stage_started_at > now()` rather than silently clamping to 0 days; add clock-skew telemetry.

## Cross-References

- **BUG-STAGE-001 ↔ BUG-SCHEMA-006** — Unbounded client-writable `current_stage` (`07-backend-models-schemas.md`) is the input side of the same skip exposure; a chain-validating unlock check is necessary but not sufficient without the schema clamp.
- **BUG-STAGE-003 ↔ BUG-PRACTICE-005** — Identical TOCTOU pattern (check-then-insert with `FOR UPDATE` on zero rows) seen in `11-practices-sessions.md` for the stage-scoped practice create path; the fix shape (unique constraint + INSERT-on-conflict) should be the same.
- **BUG-COURSE-002 ↔ BUG-GOAL-001** — Duplicate-completion race mirrors the daily-completion TOCTOU in `10-goals-completions-groups.md`; both need DB-level uniqueness.
- **BUG-COURSE-004 ↔ BUG-JOURNAL-002** — Same 404-before-403 IDOR oracle pattern called out in `12-journal.md`; unify the resolve-then-authorize ordering across all user-scoped resources.
- **BUG-STAGE-005 ↔ BUG-HABIT-002** — Aggregate metric that silently drops a tracked field; same class of bug as the habit-stats mismatch in `09-habits-streaks.md`.
