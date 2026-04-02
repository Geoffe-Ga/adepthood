# phase-3-05: Add backend routers for stages and stage progress

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-03
**Estimated LoC:** ~200–250

## Problem

The frontend needs stage data (names, descriptions, progress) but no backend endpoint serves it. The `StageProgress` SQLModel exists in `models/stage_progress.py` and the `CourseStage` model exists in `models/course_stage.py`, but neither has a router.

The Map screen, Practice screen, and Course screen all need stage data. Without a backend source, each screen defines its own hardcoded version, leading to inconsistency.

## Scope

Create a `/stages` API that serves stage definitions and tracks per-user progress.

## Tasks

1. **Create `backend/src/routers/stages.py`**
   - `GET /stages` — List all 10 stages with per-user progress (auth-gated)
   - `GET /stages/{stage_number}` — Get a single stage with detailed progress breakdown
   - `GET /stages/{stage_number}/progress` — Get progress breakdown: habits completion %, practice sessions count, course content completion %
   - `PUT /stages/{stage_number}/progress` — Update progress (called when habits/practices/course items are completed — or computed server-side)

2. **Create `backend/src/schemas/stage.py`**
   - `StageResponse`: `stage_number`, `name`, `subtitle`, `description`, `color`, `is_unlocked`, `progress` (0-1)
   - `StageProgressResponse`: `habits_progress`, `practice_sessions_completed`, `course_items_completed`, `overall_progress`
   - `StageProgressUpdate`: for manual progress updates if needed

3. **Implement progress computation**
   - Create `backend/src/domain/stage_progress.py`
   - `compute_stage_progress(user_id, stage_number)` — queries habits, practice sessions, and course completions for that stage
   - Returns a composite progress score (0-1)
   - This follows the existing domain pattern (pure function with reason code)

4. **Seed stage definitions**
   - Create a migration or seed script that populates the `CourseStage` table with the 10 APTITUDE stages
   - Stage names: Beige, Purple, Red, Blue, Orange, Green, Yellow, Turquoise, Ultraviolet, Clear Light
   - Include stage colors matching the frontend constants

5. **Stage unlock logic**
   - Stage 1 (Beige) is always unlocked
   - Stage N+1 unlocks when stage N reaches a configurable threshold (e.g., 70% progress)
   - This logic lives in the domain layer

6. **Register router in `main.py`**

7. **Write tests** — `tests/test_stages_api.py`
   - List stages returns all 10
   - Progress computation is correct
   - Unlock logic works
   - Auth-gated

## Acceptance Criteria

- `/stages` returns all 10 stages with correct names and colors
- Per-user progress is computed from real habit/practice/course data
- Stage unlock logic is enforced
- Tests cover all endpoints and edge cases

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/stages.py` | **Create** |
| `backend/src/schemas/stage.py` | **Create** |
| `backend/src/domain/stage_progress.py` | **Create** |
| `backend/src/main.py` | Modify (register stages router) |
| `backend/tests/test_stages_api.py` | **Create** |
