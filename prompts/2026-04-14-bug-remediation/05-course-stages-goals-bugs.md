# Course, Stages & Goals — Bug Remediation Report

**Component:** Course content, Stage progression/gating, Goals & Goal Groups
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

The Course / Stages / Goals subsystem — the heart of the 36-week program — has **25 bugs** spanning stage-gating logic, progress math, completion idempotency, authorization, and race conditions. Several are outright data-integrity failures:

- **Stage progress is a lie.** The `progress` field on every stage row is never populated (always 0.0), `course_items_completed` is a hardcoded 0, and `habits_progress` is a hardcoded 0.0. The "overall progress" metric therefore is mathematically capped at 0.5 and usually returns 0.0. The user sees no movement no matter what they do.
- **Stage unlock logic is too permissive** — the predicate `stage_number <= progress.current_stage` allows anyone to skip ahead by directly updating the DB or via race.
- **PUT /stages/progress has a classic TOCTOU race** — two concurrent advances can both pass the "cannot go backwards" check.
- **Locked-stage content leaks.** `GET /course/content/{id}`, `POST /course/content/{id}/mark-read`, and `GET /stages/{n}/history` all skip authorization.
- **Subtractive goal progress is inverted.** A caffeine-limit goal rewards the wrong behavior.
- **Goal completion is not idempotent.** Tapping "Complete" twice double-counts the streak.

Most of the HIGH+ findings are reachable without any special access — they're in the default success path.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-STAGE-001 | Critical | `completed_stages` array semantics ambiguous; no single-step-forward guard |
| BUG-STAGE-002 | Critical | `is_stage_unlocked` too permissive (`<=` instead of legitimate gating) |
| BUG-STAGE-004 | Critical | `habits_progress` hardcoded to 0.0 |
| BUG-STAGE-005 | Critical | TOCTOU race on `PUT /stages/progress` |
| BUG-STAGE-006 | Critical | `StageResponse.progress` never populated |
| BUG-STAGE-003 | High | `GET /stages/{n}/history` skips unlock check |
| BUG-COURSE-001 | High | `course_items_completed` hardcoded to 0 |
| BUG-COURSE-002 | High | `_days_for_user_stage` returns -1 for past stages, locks all content retroactively |
| BUG-COURSE-003 | High | Drip-feed reapplied every time user revisits past stage |
| BUG-COURSE-005 | High | `mark_content_read` skips stage-unlock check |
| BUG-COURSE-007 | High | `get_content_item` skips stage-unlock check |
| BUG-GOAL-002 | High | Subtractive goal progress inverted |
| BUG-COURSE-004 | Medium | `next_unlock_day` passes invalid `days_elapsed=-1` |
| BUG-COURSE-006 | Medium | Empty-progress response relies on implicit optional default |
| BUG-SEED-001 | Medium | Content seed doesn't check `(stage, release_day)` uniqueness |
| BUG-GOAL-001 | Medium | No validation on `completed_units` (negative/zero accepted) |
| BUG-GOAL-003 | Medium | `delete_goal_group` orphans `GoalCompletion` rows |
| BUG-GOAL-004 | Medium | `shared_template=True` not tied to `user_id IS NULL` |
| BUG-GOAL-005 | Medium | Goal completion is not idempotent within a day |
| BUG-GOAL-006 | Medium | `Goal.tier` accepts any string (no enum) |
| BUG-FRONTEND-001 | Medium | `StageSelector` hardcodes `TOTAL_STAGES=10` |
| BUG-FRONTEND-003 | Medium | Map modal close races with navigation |
| BUG-SEED-002 | Low | `seed_stages` doesn't validate uniqueness of definitions |
| BUG-FRONTEND-002 | Low | `ContentCard` relies solely on `disabled` for lock |
| BUG-FRONTEND-004 | Low | `StageHistorySection` mounts then returns null |

---

### BUG-STAGE-001: `completed_stages` semantics / no single-step-forward guard
**Severity:** Critical
**Component:** `backend/src/routers/stages.py:146` (also line 163)
**Symptom:** `completed_stages = range(1, payload.current_stage)` is applied on both create and update paths. There's no explicit contract for whether "completed_stages" means *all stages up to the current one* or *only finished ones*, and there's no guard that the user can only advance one stage at a time.
**Reproduction:** `PUT /stages/progress {"current_stage": 10}` from fresh account → succeeds; user jumps 9 stages.
**Root cause:**
```python
completed = list(range(1, payload.current_stage))  # stages.py:146
# The `cannot_go_backwards` check only rejects <=, not skipping
```
**Fix:** Enforce `payload.current_stage == existing.current_stage + 1` (or accept an admin override). Freeze the semantics in a docstring.

---

### BUG-STAGE-002: `is_stage_unlocked` too permissive
**Severity:** Critical
**Component:** `backend/src/domain/stage_progress.py:30-40`
**Symptom:** Predicate `stage_number <= progress.current_stage` returns True for *every* stage up to the current one, regardless of whether those stages were actually completed. Combined with BUG-STAGE-001, a DB-level mutation or race can advance `current_stage` without populating `completed_stages`, and every earlier stage becomes implicitly unlocked.
**Fix:** Keep exactly one source of truth (completed_stages) and rewrite:
```python
if stage_number == 1:
    return True
if progress is None:
    return False
if stage_number <= progress.current_stage:
    return stage_number - 1 in (progress.completed_stages or []) or stage_number == 1
return False
```

---

### BUG-STAGE-003: `/stages/{n}/history` skips unlock check
**Severity:** High
**Component:** `backend/src/routers/stages.py:113-130`
**Symptom:** User on stage 1 can `GET /stages/10/history` and see everything they haven't earned.
**Fix:** Add `is_stage_unlocked` check before aggregating.

---

### BUG-STAGE-004: `habits_progress` hardcoded to 0.0
**Severity:** Critical
**Component:** `backend/src/domain/stage_progress.py:60`
**Symptom:** The overall progress metric is `(habits_progress + (1 if practice_count > 0 else 0)) / 2`. Because `habits_progress = 0.0` is a placeholder, overall progress is capped at 0.5 and is 0.0 for users with no practice sessions.
**Fix:** Count `Habit` rows for the stage and the number with at least one `GoalCompletion`; compute the ratio. See the auditor's draft SQL in the internal notes (joining `Habit` → `Goal` → `GoalCompletion`).

---

### BUG-STAGE-005: TOCTOU race on `PUT /stages/progress`
**Severity:** Critical
**Component:** `backend/src/routers/stages.py:133-173`
**Symptom:** Two concurrent advance requests both read the same `current_stage`, both pass the "cannot go backwards" check, both commit → non-deterministic final state.
**Fix:** Lock the row with `SELECT ... FOR UPDATE` (SQLAlchemy `.with_for_update()`) at the start of the transaction. Commit/refresh afterward.

---

### BUG-STAGE-006: `StageResponse.progress` never populated
**Severity:** Critical
**Component:** `backend/src/routers/stages.py:48-64`
**Symptom:** `list_stages` never sets `progress`, so every stage in the list carries the schema default (0.0). The frontend progress bar never moves.
**Fix:** Compute stage progress per stage (batch-friendly) and populate. Alternatively, remove the field and have the client call `/stages/{n}/progress` when it needs it.

---

### BUG-COURSE-001: `course_items_completed` hardcoded to 0
**Severity:** High
**Component:** `backend/src/domain/stage_progress.py:63`
**Symptom:** TODO left in place; `ContentCompletion` rows are never counted.
**Fix:** Count `ContentCompletion` joined to `StageContent` joined to `CourseStage.stage_number`.

---

### BUG-COURSE-002: `_days_for_user_stage` returns -1 for non-current stages
**Severity:** High
**Component:** `backend/src/routers/course.py:37-42`, `backend/src/domain/course.py:31`
**Symptom:** When the user revisits a *past* stage, `days_elapsed = -1`, and drip-feed logic `release_day > days_elapsed` evaluates true for every item — so previously-unlocked content becomes locked retroactively.
**Fix:** Return a sentinel (e.g. a very large day count) when `progress.current_stage > stage_number`, so all content for past stages is unlocked.

---

### BUG-COURSE-003: Drip-feed replays for past stages
**Severity:** High
**Component:** `backend/src/routers/course.py:75-97`
**Symptom:** No authorization check, and drip-feed is applied based on the *current* stage start date rather than the stage the user is viewing.
**Fix:** Gate with `is_stage_unlocked`; for past stages, skip drip-feed entirely.

---

### BUG-COURSE-004: `next_unlock_day` invoked with -1
**Severity:** Medium
**Component:** `backend/src/routers/course.py:214-222`
**Symptom:** When the user is not on the requested stage, `days = max(..., -1) = -1` is passed through, producing nonsensical `next_unlock_day` values.
**Fix:** Short-circuit: `next_day = None if days < 0 else next_unlock_day(...)`.

---

### BUG-COURSE-005: `mark_content_read` skips stage check
**Severity:** High
**Component:** `backend/src/routers/course.py:141-178`
**Symptom:** User can mark content from a locked stage as read by guessing the content ID.
**Fix:** Look up the parent stage and call `is_stage_unlocked` before inserting the completion.

---

### BUG-COURSE-006: Empty progress response couples to schema default
**Severity:** Medium
**Component:** `backend/src/routers/course.py:181-185`
**Symptom:** `_empty_progress()` passes `next_unlock_day=None`; schema change to required breaks this silently.
**Fix:** Explicit `int | None` in the response schema, with test coverage.

---

### BUG-COURSE-007: `get_content_item` skips stage check
**Severity:** High
**Component:** `backend/src/routers/course.py:100-138`
**Symptom:** Leaks the existence and metadata of content in locked stages.
**Fix:** Same pattern as BUG-COURSE-005.

---

### BUG-SEED-001: Content seed lacks `(stage, release_day)` uniqueness
**Severity:** Medium
**Component:** `backend/src/seed_content.py:113-116`
**Symptom:** Two items with the same release day in the same stage will both persist; drip-feed assumes one item per day.
**Fix:** Track existing `(course_stage_id, release_day)` tuples; assert uniqueness in `STAGE_CONTENT_DEFINITIONS` at module import time.

---

### BUG-SEED-002: `seed_stages` doesn't assert uniqueness
**Severity:** Low
**Component:** `backend/src/seed_stages.py:144-161`
**Symptom:** Duplicate `stage_number` in definitions → only one inserted, silently.
**Fix:** Raise at import: `assert len({d['stage_number'] for d in STAGE_DEFINITIONS}) == len(STAGE_DEFINITIONS)`.

---

### BUG-GOAL-001: `completed_units` unvalidated
**Severity:** Medium
**Component:** `backend/src/routers/goal_completions.py:48-72`, `backend/src/models/goal_completion.py`
**Symptom:** Model and API accept negative / zero / absurd values.
**Fix:** `Field(gt=0)` and a ceiling (`le=goal.target * reasonable_factor`).

---

### BUG-GOAL-002: Subtractive goal progress inverted
**Severity:** High
**Component:** `backend/src/domain/goals.py:24-26`
**Symptom:** Caffeine-style "stay under N" goals reward consumption. `progress = remaining / target` is the inverse of what success means.
**Fix:** See the recommendation in the audit — 100% when `current <= 0`, 0% when `current >= target`, proportional between.

---

### BUG-GOAL-003: `delete_goal_group` orphans completions
**Severity:** Medium
**Component:** `backend/src/routers/goal_groups.py:137-157`
**Symptom:** Cascade behavior inconsistent; no DB constraint.
**Fix:** Add FK `ondelete="SET NULL"` on `Goal.goal_group_id`; explicitly commit the unlink before deleting.

---

### BUG-GOAL-004: `shared_template` not tied to `user_id IS NULL`
**Severity:** Medium
**Component:** `backend/src/routers/goal_groups.py:40-53`, `90-102`
**Symptom:** The shared-template invariant is enforced in the create handler but not at the DB layer. A direct insert or a future refactor can break it.
**Fix:** Add DB CHECK constraint: `(shared_template = true AND user_id IS NULL) OR (shared_template = false AND user_id IS NOT NULL)`.

---

### BUG-GOAL-005: Completion not idempotent
**Severity:** Medium
**Component:** `backend/src/routers/goal_completions.py:47-72`
**Symptom:** Double-tap or retry → double streak.
**Fix:** Check for an existing completion today; return the current streak instead of inserting. Add a partial unique index on `(goal_id, user_id, date(timestamp))`.

---

### BUG-GOAL-006: `Goal.tier` accepts any string
**Severity:** Medium
**Component:** `backend/src/models/goal.py:33`
**Symptom:** `tier="banana"` accepted; frontend badge logic crashes / shows wrong color.
**Fix:** `StrEnum("GoalTier", "low clear stretch")` or Pydantic `pattern="^(low|clear|stretch)$"`.

---

### BUG-FRONTEND-001: `StageSelector` hardcodes 10 stages
**Severity:** Medium
**Component:** `frontend/src/features/Course/StageSelector.tsx:51`
**Symptom:** Fragile — always renders 10 pills even if API returns fewer. When the 36-week program is expanded, pills for stages 11+ won't appear.
**Fix:** Derive count from API: `Math.max(...stages.map(s => s.stage_number))`.

---

### BUG-FRONTEND-002: `ContentCard` relies solely on `disabled`
**Severity:** Low
**Component:** `frontend/src/features/Course/ContentCard.tsx:52-63`
**Symptom:** Long-press / accessibility activation can still fire `onPress`.
**Fix:** Guard the handler: `if (item.is_locked) return;`.

---

### BUG-FRONTEND-003: Map modal close races with navigation
**Severity:** Medium
**Component:** `frontend/src/features/Map/MapScreen.tsx:440-448`
**Symptom:** Rapid back-press after picking a destination leaves UI in inconsistent state.
**Fix:** Chain navigation inside the state update via `InteractionManager.runAfterInteractions` or a ref guard.

---

### BUG-FRONTEND-004: `StageHistorySection` mounts then returns null
**Severity:** Low
**Component:** `frontend/src/features/Map/MapScreen.tsx:295-327`
**Symptom:** Effect fires and loading state is set before the null-guard shortcuts the render.
**Fix:** Gate mounting at the parent: `{isUnlocked && <StageHistorySection ... />}`.

---

## Suggested remediation order

1. **STAGE-005** (race) + **STAGE-006** (progress never populated) — ship first; they're pure data-integrity and low-risk.
2. **STAGE-002** + **STAGE-001** — lock down stage advancement semantics, add regression tests.
3. **COURSE-005, COURSE-007, STAGE-003** — authorization hardening.
4. **STAGE-004, COURSE-001** — implement real progress math; expect snapshot test churn.
5. **COURSE-002, COURSE-003** — past-stage drip-feed fix.
6. **GOAL-002, GOAL-005** — goal semantics and idempotency.
7. Remaining MEDIUM / LOW in a cleanup PR.
