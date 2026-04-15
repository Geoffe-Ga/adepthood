# Practice Sessions — Bug Remediation Report

**Component:** Practices, Practice Sessions, Practice Timer UI
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

The Practices feature contains 17 distinct bugs spanning timer drift / state management, session persistence, practice unlock bypass, missing validation, authorization gaps, schema mismatches, and UX issues. The highest-impact issues are:

1. **Timer always logs full `durationMinutes`** instead of actual elapsed time, so every cancel/pause is silently recorded as a completed session.
2. **Unapproved practices are retrievable** via `GET /practices/{id}`, bypassing the approval gate that `list_practices` enforces.
3. **No stage-unlock check** when selecting a practice — users can pick practices from locked stages.
4. **No min-value validation** on duration fields — negative and zero durations are accepted.
5. **Users can hold multiple active practices for the same stage** because there's no uniqueness constraint on `(user_id, stage_number)`.

These are not cosmetic — they corrupt the core data the program depends on (elapsed-time metrics, progression state) and invite inconsistent UX.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-PRACTICE-001 | Critical | Timer logs intended duration, not elapsed time |
| BUG-PRACTICE-002 | Critical | Unapproved practices retrievable via GET `/practices/{id}` |
| BUG-PRACTICE-003 | High | No min-value validation on duration fields |
| BUG-PRACTICE-004 | High | `create_user_practice` skips stage-unlock check |
| BUG-PRACTICE-005 | High | `stage_number` has no bounds validation |
| BUG-PRACTICE-006 | High | Future timestamps silently accepted for sessions |
| BUG-PRACTICE-007 | Medium | Pause/resume state not persisted across backgrounding |
| BUG-PRACTICE-008 | Medium | Timer not cancelled when user navigates away |
| BUG-PRACTICE-009 | Medium | `list_sessions` returns arbitrary order (no `order_by`) |
| BUG-PRACTICE-010 | Medium | No loading state on "Start Practice" → duplicate UserPractice rows |
| BUG-PRACTICE-011 | Medium | No uniqueness constraint on `(user_id, stage_number)` |
| BUG-PRACTICE-012 | Medium | No runtime schema validation of practice API responses |
| BUG-PRACTICE-013 | Medium | Locked-stage selector shows "empty" instead of "locked" |
| BUG-PRACTICE-014 | Low | Audio playback failures silently swallowed |
| BUG-PRACTICE-015 | Low | `default_duration_minutes` is `int` in model, `float` in sessions |
| BUG-PRACTICE-016 | Low | Uses `== True` instead of `.is_(True)` |
| BUG-PRACTICE-017 | Low | Missing accessibility labels on timer buttons |

---

### BUG-PRACTICE-001: Timer logs intended duration, not elapsed time
**Severity:** Critical
**Component:** `frontend/src/features/Practice/PracticeTimer.tsx:147`
**Symptom:** Every session logs the full `durationMinutes`, regardless of how long the user actually practiced. Cancel at 30s of a 10min session → server records a 10-minute session.
**Reproduction:**
1. Start a 10-minute practice.
2. Pause after 30 seconds, tap cancel.
3. Inspect `/practice-sessions/` — row shows 10 minutes.
**Root cause:** `onComplete` is handed the intended duration instead of the actual elapsed time:
```tsx
// PracticeTimer.tsx:147
onComplete(durationMinutes);
```
**Fix:**
```tsx
const elapsedMinutes = (totalSeconds - remaining) / 60;
onComplete(elapsedMinutes);
```
Also ensure the backend schema accepts fractional minutes (see BUG-PRACTICE-015).

---

### BUG-PRACTICE-002: Unapproved practices leak via GET `/practices/{id}`
**Severity:** Critical
**Component:** `backend/src/routers/practices.py:35-46`
**Symptom:** Any authenticated user can fetch a practice pending approval — full instructions, metadata — by guessing or iterating IDs.
**Reproduction:**
1. Seed a practice with `approved=False`.
2. `GET /practices/{id}` → returns 200 with full body.
**Root cause:** `get_practice` filters by ID only; the approval predicate in `list_practices` is not applied:
```python
# routers/practices.py:42-45
practice = result.scalars().first()
if practice is None:
    raise not_found("practice")
return practice
```
**Fix:**
```python
if practice is None or not practice.approved:
    raise not_found("practice")
```
Add an admin override if moderators must preview unapproved practices.

---

### BUG-PRACTICE-003: No minimum-value validation on duration
**Severity:** High
**Component:** `backend/src/schemas/practice.py:37`, `backend/src/schemas/practice.py:92`
**Symptom:** API accepts `default_duration_minutes: -5` and session rows with `duration_minutes: 0` or negative.
**Reproduction:** `POST /practices/` with `{"default_duration_minutes": -10}` → 201.
**Root cause:**
```python
default_duration_minutes: int  # no constraint
duration_minutes: float        # no constraint
```
**Fix:** `Field(gt=0)` on both (and `le=24*60` as a sanity upper bound).

---

### BUG-PRACTICE-004: User-practice creation skips stage-unlock check
**Severity:** High
**Component:** `backend/src/routers/user_practices.py:34-46`
**Symptom:** A user on stage 1 can select a stage-3 practice by passing `stage_number: 3`. The endpoint only validates the practice's existence and approval.
**Reproduction:** `POST /user-practices/ {practice_id: X, stage_number: 3}` for a user whose `StageProgress` shows stage 3 locked → 201.
**Root cause:** No call to `is_stage_unlocked` before insert.
**Fix:**
```python
user_progress = await get_user_progress(session, current_user)
if not is_stage_unlocked(payload.stage_number, user_progress):
    raise bad_request("stage_not_unlocked")
```

---

### BUG-PRACTICE-005: `stage_number` unbounded
**Severity:** High
**Component:** `backend/src/schemas/practice.py:21, 25, 33, 37`
**Symptom:** `stage_number=0` or negative values accepted everywhere stage_number is a field.
**Fix:** `stage_number: int = Field(ge=1, le=36)` (36 = program length).

---

### BUG-PRACTICE-006: Future timestamps silently accepted
**Severity:** High
**Component:** `backend/src/models/practice_session.py:18-21`
**Symptom:** Model uses `default_factory=datetime.now(UTC)` but has no validator preventing future timestamps if the field becomes user-supplied (and currently nothing in the schema forbids it being sent by a crafted client).
**Fix:** Pydantic validator rejecting `v > datetime.now(UTC) + small_skew`.

---

### BUG-PRACTICE-007: Pause/resume state lost on app background
**Severity:** Medium
**Component:** `frontend/src/features/Practice/PracticeTimer.tsx:44-70`
**Symptom:** iOS/Android suspend the RN thread when backgrounded; a paused timer's `remaining` is reset, and when the user foregrounds and completes, elapsed time is wrong. No AsyncStorage checkpointing.
**Fix:** Persist `{started_at, paused_at, total_pause_ms}` to AsyncStorage on `AppState` change, reconcile on focus.

---

### BUG-PRACTICE-008: Timer not cancelled on navigate-away
**Severity:** Medium
**Component:** `frontend/src/features/Practice/PracticeScreen.tsx:414-422`
**Symptom:** User navigates away mid-session → timer keeps running in memory, no session is recorded, and returning shows a stale timer state.
**Fix:** `useFocusEffect` returning a cleanup that either saves or explicitly discards the active session.

---

### BUG-PRACTICE-009: `list_sessions` returns arbitrary order
**Severity:** Medium
**Component:** `backend/src/routers/practice_sessions.py:49-62`
**Symptom:** Sessions come back in whatever order Postgres picks.
**Fix:** Append `.order_by(col(PracticeSession.timestamp).desc())` and add pagination (`limit`/`offset`).

---

### BUG-PRACTICE-010: No loading state on "Start Practice"
**Severity:** Medium
**Component:** `frontend/src/features/Practice/PracticeScreen.tsx:166-173`
**Symptom:** Slow network → user double-taps → duplicate `UserPractice` rows (see BUG-PRACTICE-011).
**Fix:** Local `isSubmitting` flag, disable the button, show a spinner.

---

### BUG-PRACTICE-011: No uniqueness on `(user_id, stage_number)`
**Severity:** Medium
**Component:** `backend/src/models/user_practice.py`, `backend/src/routers/user_practices.py:27-51`
**Symptom:** Two active practices can exist for the same stage, confusing every downstream aggregation.
**Fix:** Partial unique index `(user_id, stage_number) WHERE end_date IS NULL` + pre-insert check returning 409.

---

### BUG-PRACTICE-012: No runtime validation of practice API responses
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:871-872`
**Symptom:** TS interfaces are compile-time only; a backend schema drift passes through and crashes deep in UI code.
**Fix:** Zod schema + `.parse` at the API boundary.

---

### BUG-PRACTICE-013: Locked-stage selector shows "No practices available"
**Severity:** Medium
**Component:** `frontend/src/features/Practice/PracticeSelector.tsx:62-68`
**Symptom:** Users can't tell whether a stage has no practices or is simply locked.
**Fix:** Accept `isLocked` prop and render a distinct empty state.

---

### BUG-PRACTICE-014: Audio playback failures silently swallowed
**Severity:** Low
**Component:** `frontend/src/features/Practice/PracticeTimer.tsx:20-30`
**Symptom:** Missing asset / permission denied → no bell, no indication. Users assume timer didn't start.
**Fix:** `console.warn` + haptic fallback.

---

### BUG-PRACTICE-015: `int` vs `float` duration mismatch
**Severity:** Low
**Component:** `backend/src/models/practice.py:12` vs `backend/src/models/practice_session.py:17`
**Symptom:** Practice template duration is `int` minutes but logged sessions are `float`. Arithmetic comparisons and reports cast inconsistently.
**Fix:** Choose one (probably `float` to allow 7.5-min practices) and migrate.

---

### BUG-PRACTICE-016: `== True` instead of `.is_(True)`
**Severity:** Low
**Component:** `backend/src/routers/practices.py:28-29`
**Symptom:** Linter-silenced stylistic issue; slightly worse query plans on nullable booleans.
**Fix:** `Practice.approved.is_(True)`.

---

### BUG-PRACTICE-017: Missing accessibility labels on timer buttons
**Severity:** Low
**Component:** `frontend/src/features/Practice/PracticeScreen.tsx:452-467`
**Symptom:** Screen reader users hear "Button" repeatedly.
**Fix:** `accessibilityLabel`/`accessibilityRole="button"` on Pause/Resume/Cancel/Complete.

---

## Suggested remediation order

1. 001, 002 (data-integrity / security) — same PR.
2. 003, 004, 005 (validation hardening) — same PR; add regression tests.
3. 011 + 010 (uniqueness + loading state) — must ship together or the uniqueness check surfaces as a UX bug.
4. 009 (sort+paginate) — cheap and improves every list screen.
5. 007 + 008 (timer lifecycle) — write a small state machine, cover with tests.
6. Remaining (012–017).
