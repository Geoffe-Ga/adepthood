# phase-3-02: Build Course backend — stage content with drip-feed scheduling

**Labels:** `phase-3`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-01
**Estimated LoC:** ~200–250

## Problem

The spec defines Course content as drip-fed essays, prompts, and videos tied to stages. The `StageContent` model has:

```python
class StageContent(SQLModel, table=True):
    course_stage_id: int = Field(foreign_key="coursestage.id")
    title: str
    content_type: str  # "essay", "prompt", "video"
    release_day: int   # days since user started this stage
    url: str           # hosted on Squarespace CMS
```

Content is **not stored in the database** — it's hosted on Squarespace. The `url` field points to the external CMS. The `release_day` field enables drip-feeding: content becomes available N days after the user starts a stage.

No router exists to serve this.

## Scope

Build the Course content API with drip-feed gating and read-tracking.

## Tasks

1. **Create `backend/src/routers/course.py`**
   - `GET /course/stages/{stage_number}/content` — List content items for a stage, filtered by `release_day <= days_since_stage_start`. Items not yet released should be returned with `is_locked: true` and no `url` (prevent spoilers).
   - `GET /course/content/{content_id}` — Single content item (returns URL to CMS-hosted content)
   - `POST /course/content/{content_id}/mark-read` — Mark content as read (auth-gated). Creates a completion record.
   - `GET /course/stages/{stage_number}/progress` — Percentage of content items marked as read

2. **Create `backend/src/schemas/course.py`**
   - `ContentItemResponse`: `id`, `title`, `content_type`, `release_day`, `url` (null if locked), `is_locked`, `is_read`
   - `CourseProgressResponse`: `total_items`, `read_items`, `progress_percent`, `next_unlock_day`

3. **Implement drip-feed logic in `backend/src/domain/course.py`**
   - `get_available_content(stage_number, days_since_start)` — returns content where `release_day <= days_since_start`
   - `days_since_start` computed from `StageProgress` or `UserPractice.start_date`

4. **Create a read-tracking model** (or reuse a generic completion model)
   - `ContentCompletion(user_id, content_id, completed_at)`

5. **Seed content definitions**
   - Populate `StageContent` with at least placeholder entries for stages 1-3
   - Include CMS URLs (can be placeholder URLs initially)

6. **Register router, write tests**

## Acceptance Criteria

- Content items gated by `release_day` — locked items return no URL
- Read-tracking persists per user
- Progress accurately reflects read/total ratio
- Tests cover drip-feed gating edge cases

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/course.py` | **Create** |
| `backend/src/schemas/course.py` | **Create** |
| `backend/src/domain/course.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_course_api.py` | **Create** |
