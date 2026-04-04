# phase-3-01: Add backend routers for stages and stage progress

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-03
**Estimated LoC:** ~250–300

## Problem

The frontend needs stage data (names, descriptions, progress) but no backend endpoint serves it. The `StageProgress` SQLModel exists with `current_stage`, `completed_stages: list[int]`, and `user_id`. The `CourseStage` model has rich metadata fields specified in the data model:

```python
class CourseStage(SQLModel, table=True):
    title: str
    subtitle: str
    stage_number: int
    overview_url: str
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str
```

The Map, Practice, Course, and Habits screens all need stage data. Without a backend source, each screen would hardcode its own version.

## Scope

Create a `/stages` API that serves the full `CourseStage` definitions and tracks per-user progress via `StageProgress`.

## Tasks

1. **Create `backend/src/routers/stages.py`**
   - `GET /stages` — List all 10 stages with per-user progress (auth-gated). Returns `CourseStage` fields + user's `StageProgress` overlay.
   - `GET /stages/{stage_number}` — Single stage with full metadata + progress breakdown
   - `GET /stages/{stage_number}/progress` — Detailed progress: habits %, practice sessions count, course content %
   - `PUT /stages/progress` — Update current stage (called when user advances)

2. **Create `backend/src/schemas/stage.py`**
   - `StageResponse`: All `CourseStage` fields + `is_unlocked: bool`, `progress: float` (0-1)
   - `StageDetailResponse`: Extends with `practices: list`, `habits: list`, `content_items: list`
   - `StageProgressResponse`: `habits_progress`, `practice_sessions_completed`, `course_items_completed`, `overall_progress`

3. **Create `backend/src/domain/stage_progress.py`**
   - `compute_stage_progress(user_id, stage_number)` — Queries habits, practice sessions, and course completions for that stage
   - Stage unlock logic: Stage 1 always unlocked, Stage N+1 unlocks at configurable threshold of Stage N

4. **Seed stage definitions**
   - Migration or seed script populating `CourseStage` with the 10 APTITUDE stages using the exact metadata from the data model spec:
     - Beige: Survival / "Active Yes-And-Ness"
     - Purple: Magick / "Receptive Yes-And-Ness"
     - Red: Power / "Self-Love"
     - Blue: Conformity / "Universal Love"
     - Orange: Achievist / "Intellectual Understanding"
     - Green: Pluralist / "Embodied Understanding"
     - Yellow: Integrative / "Systems Wisdom"
     - Turquoise: Nondual / "Transcendent Wisdom"
     - Ultraviolet: Effortless Being / "Unity of Being"
     - Clear Light: Pure Awareness / "Emptiness and Awareness"

5. **Register router in `main.py`**, write tests

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/stages.py` | **Create** |
| `backend/src/schemas/stage.py` | **Create** |
| `backend/src/domain/stage_progress.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_stages_api.py` | **Create** |
