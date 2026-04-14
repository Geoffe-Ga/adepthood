# Habits — Bug Remediation Report

**Component:** Habits, Goals (per-habit), Check-ins, Streaks, Milestones, Energy
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

The Habits surface is the daily-driver of the program and shows the most tech debt. There are **20 bugs** covering timezone correctness, concurrency, cascade integrity, and optimistic-UI recovery. The ones that corrupt data on the happy path:

- **`Habit.streak` is never recomputed on `GET /habits`** — it's returned as 0 regardless of completions. UI shows stale or zero streaks on every app open.
- **Backend streak counts rows, not unique days** — two check-ins in the same day bump the streak by 2.
- **No `(goal_id, user_id, date)` uniqueness** — a retry after a server timeout double-records.
- **Day-of-week aggregation uses local time on the client and UTC on the server** — bars land on the wrong day around midnight.
- **Delete-habit doesn't cascade to goals/completions** — orphans linger and can bleed into new habits.
- **Check-in is not serialized** — two taps race and both report streak=N instead of N+1.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-HABITS-001 | High | Day-of-week index mismatch between backend UTC and frontend local |
| BUG-HABITS-002 | High | Missing compound index on `goal_completion(goal_id, user_id, timestamp)` |
| BUG-HABITS-003 | High | Concurrent check-ins race on streak computation |
| BUG-HABITS-004 | High | Habit delete doesn't cascade — orphan goals/completions |
| BUG-HABITS-016 | High | Subtractive goal tier resolution semantics unclear |
| BUG-HABITS-017 | High | `GET /habits` returns stale `streak` (never recomputed) |
| BUG-HABITS-005 | Medium | Frontend `new Date(raw.start_date)` parses ISO as local |
| BUG-HABITS-006 | Medium | Off-by-one in completion-date collection |
| BUG-HABITS-007 | Medium | Failed check-in rolls back with no retry queue |
| BUG-HABITS-008 | Medium | Milestone toast can double-fire on retry |
| BUG-HABITS-009 | Medium | Completion-rate precision loss from `Math.round` |
| BUG-HABITS-010 | Medium | `energy_cost` / `energy_return` accept negative values |
| BUG-HABITS-011 | Medium | Streak counts rows, not unique days |
| BUG-HABITS-013 | Medium | `persistHabits` is fire-and-forget; crash loses the check-in |
| BUG-HABITS-015 | Medium | No unique constraint per (goal, user, day) |
| BUG-HABITS-020 | Medium | `CheckInResult` lacks updated habit/goals |
| BUG-HABITS-012 | Low | Goal target change doesn't renormalize progress |
| BUG-HABITS-014 | Low | "Unlock early" is client-only — no server authorization |
| BUG-HABITS-018 | Low | Energy plan includes dates before `habit.start_date` |
| BUG-HABITS-019 | Low | `per_month` normalization uses hardcoded 30 days |

---

### BUG-HABITS-001: Day-of-week mismatch (UTC vs local)
**Severity:** High
**Component:** `backend/src/domain/habit_stats.py:38`, `frontend/src/features/Habits/HabitUtils.ts:316`
**Symptom:** Stats bars shift by one day around midnight for users in non-UTC timezones.
**Fix:** Pick one reference — UTC is cleanest for storage; the display can render "user-local" if the client normalizes via `.toISOString()` consistently. Covered with a parameterized test across ±14h TZ offsets.

---

### BUG-HABITS-002: Missing compound index
**Severity:** High
**Component:** `backend/src/models/goal_completion.py:11-25`
**Symptom:** Streak computation is an ORDER-BY-without-index scan; latency grows linearly with completion count.
**Fix:** `Index("ix_goal_completion_goal_user_timestamp", "goal_id", "user_id", "timestamp")`. Add migration.

---

### BUG-HABITS-003: Concurrent check-ins race
**Severity:** High
**Component:** `backend/src/routers/goal_completions.py:47-72`, `backend/src/services/streaks.py`
**Symptom:** Two quick taps both compute streak from the same pre-insert state and return the same value; second response shows unchanged streak.
**Fix:** Use `.with_for_update()` on the lookup or enforce at DB level with the unique-per-day constraint (BUG-HABITS-015). Re-read the streak after commit.

---

### BUG-HABITS-004: Delete cascade missing
**Severity:** High
**Component:** `backend/src/models/goal.py:29-30`, `backend/src/models/habit.py`, `backend/src/routers/habits.py:89-101`
**Symptom:** Deleting a habit leaves its goals and completions in place.
**Fix:** Declare `ondelete="CASCADE"` on `Goal.habit_id` (and transitively on `GoalCompletion.goal_id`). Add explicit deletes in the handler until the migration lands. Consider a soft-delete column if restoration is desired.

---

### BUG-HABITS-016: Subtractive goal tier resolution semantics
**Severity:** High
**Component:** `frontend/src/features/Habits/HabitUtils.ts:165-185, 245-255`
**Symptom:** Tightly coupled to BUG-GOAL-002 in the Goals report. The comparisons are numerically right but the naming assumes additive semantics; downstream UI can mis-render.
**Fix:** Align with the fix for BUG-GOAL-002 in `05-course-stages-goals-bugs.md`. Rename locals to `isUnderLimit`, `severity`, etc., and add a snapshot test.

---

### BUG-HABITS-017: `GET /habits` returns stale `streak`
**Severity:** High
**Component:** `backend/src/routers/habits.py:37-50`; `frontend/src/features/Habits/services/habitManager.ts:75-93`
**Symptom:** UI shows streak 0 after restart even when the user has logged for weeks.
**Fix:** Compute streak per habit server-side on `GET /habits` (eager-loaded) — or split: `/habits` is static, `/habits/stats` has computed values, and the client merges. The current `streak: 0` hardcoded on the client side is the actual source of the stale value; that's a one-line frontend fix once the backend exposes a truth.

---

### BUG-HABITS-005: Frontend parses ISO strings as local
**Severity:** Medium
**Component:** `frontend/src/storage/habitStorage.ts:14-19`, `HabitUtils.ts:319`
**Symptom:** `toDateString()` / `getDay()` operate in local TZ.
**Fix:** Compute the bucket with `toISOString().slice(0,10)` (UTC) everywhere, or a shared helper `dayKey(date)` used by both aggregation and comparisons.

---

### BUG-HABITS-006: Off-by-one in completion-date collection
**Severity:** Medium
**Component:** `frontend/src/features/Habits/HabitUtils.ts:364-365`
**Symptom:** `?? ''` fallback inserts empty strings that skew downstream stats.
**Fix:** Filter `isNaN(d.getTime())` first; drop the `?? ''`.

---

### BUG-HABITS-007: Optimistic check-in failure has no retry queue
**Severity:** Medium
**Component:** `frontend/src/features/Habits/services/habitManager.ts:393-420`
**Symptom:** Airplane-mode tap → optimistic update → server call fails → revert → user's intent is lost.
**Fix:** Store pending check-ins in AsyncStorage, replay on reconnect. Surface a "pending" badge.

---

### BUG-HABITS-008: Milestone toast can double-fire
**Severity:** Medium
**Component:** `backend/src/routers/goal_completions.py:70`, `frontend/.../habitManager.ts:238-245`
**Symptom:** A retried success returns the same milestone list; client fires the toast twice.
**Fix:** Backend returns only *newly crossed* thresholds (`old_streak < t <= new_streak`). Client keeps a `shownMilestones` set keyed by habit id.

---

### BUG-HABITS-009: Completion-rate precision
**Severity:** Medium
**Component:** `frontend/src/features/Habits/HabitUtils.ts:342-348`
**Symptom:** Rare rate > 100% or rounding glitches when timestamps straddle DST.
**Fix:** Use `Math.floor` on UTC-midnight-normalized day diffs.

---

### BUG-HABITS-010: Energy accepts negatives
**Severity:** Medium
**Component:** `backend/src/schemas/habit.py:58-59`
**Fix:** `Field(ge=0, le=1000)` on `energy_cost` and `energy_return`.

---

### BUG-HABITS-011: Streak counts rows, not days
**Severity:** Medium
**Component:** `backend/src/services/streaks.py:28-51`
**Fix:** Query `DISTINCT DATE(timestamp)` descending; collapse to day-level streak. Same once BUG-HABITS-015 (unique per day) lands.

---

### BUG-HABITS-013: Fire-and-forget persist
**Severity:** Medium
**Component:** `frontend/.../habitManager.ts:402`, `storage/habitStorage.ts:22-24`
**Fix:** `await persistHabits(...)` before returning the updated habit. If the caller can't await (event handlers), wrap in a queue that drains on app state changes.

---

### BUG-HABITS-015: No uniqueness per day
**Severity:** Medium
**Component:** `backend/src/models/goal_completion.py`
**Fix:** Migration adding `UNIQUE(goal_id, user_id, DATE(timestamp))`; handle the `IntegrityError` as "already logged today".

---

### BUG-HABITS-020: `CheckInResult` missing updated habit
**Severity:** Medium
**Component:** `backend/src/schemas/checkin.py:12-20`, `backend/src/routers/goal_completions.py`
**Symptom:** Client has to re-fetch `/habits` to see new tier/milestone state.
**Fix:** Embed the updated `HabitWithGoals` in the response.

---

### BUG-HABITS-012: Target change doesn't renormalize
**Severity:** Low
**Component:** `frontend/.../habitManager.ts:95-102`
**Fix:** Either document that increasing target preserves absolute units (and the progress bar regresses proportionally), or offer the user a choice on edit.

---

### BUG-HABITS-014: Client-only "unlock early"
**Severity:** Low
**Component:** `frontend/.../habitManager.ts:457-461`
**Fix:** Move to `POST /habits/{id}/unlock` with server-side eligibility check (stage progress, prior habits, etc.).

---

### BUG-HABITS-018: Energy plan includes dates before start
**Severity:** Low
**Component:** `backend/src/domain/energy.py:45-62`
**Fix:** Skip offsets where `habit.start_date > current_date`.

---

### BUG-HABITS-019: `per_month` hardcodes 30 days
**Severity:** Low
**Component:** `frontend/.../HabitUtils.ts:120-132`
**Fix:** Use 30.437 (365.25/12) or compute dynamically per calendar month.

---

## Suggested remediation order

1. **017** (stale streak) + **002** (index) + **011** (streak from days) — land the backend compute together; write a regression test per bug.
2. **015** (unique per day) + **003** (race) — these are the same fix fundamentally; once (goal, user, day) is unique, the race is resolved at the DB layer.
3. **004** (cascade) — migration with explicit deletes.
4. **001, 005, 006** (timezone/date correctness) — all small, all testable.
5. **007, 013** (offline resilience) — coordinated client change.
6. **008, 010, 020** (API polish).
7. Remaining LOWs.
