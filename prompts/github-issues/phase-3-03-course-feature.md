# phase-3-03: Build Course backend router and frontend screen

**Labels:** `phase-3`, `frontend`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-10, phase-3-05
**Estimated LoC:** ~250 backend, ~250 frontend

## Problem

The Course screen is a placeholder:

```tsx
const CourseScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Course Screen</Text>
    </View>
  );
};
```

The backend has `CourseStage` and `StageContent` SQLModels defined but no router to serve them. The README describes this as: "Explore educational content stage by stage through the APTITUDE program." The APTITUDE program has 10 stages, each with educational content, exercises, and readings.

## Scope

Build a content browsing interface where users can read stage-by-stage course material. Content authoring/CMS is out of scope — seed the database with initial content.

## Tasks

### Backend

1. **Create `backend/src/routers/course.py`**
   - `GET /course/stages` — List all 10 stages with titles, descriptions, and completion status
   - `GET /course/stages/{stage_number}` — Get a single stage with its content items
   - `GET /course/stages/{stage_number}/content` — List content items for a stage (lessons, readings, exercises)
   - `POST /course/stages/{stage_number}/complete` — Mark a content item as completed (auth-gated)

2. **Create `backend/src/schemas/course.py`**
   - `StageOverview`: `stage_number`, `title`, `subtitle`, `description`, `color`, `is_unlocked`, `progress`
   - `StageDetail`: extends StageOverview with `content_items: list[ContentItem]`
   - `ContentItem`: `id`, `title`, `type` (lesson/reading/exercise), `body`, `order`, `is_completed`

3. **Create seed data script or migration**
   - Populate the 10 stages with titles matching the APTITUDE framework
   - Add placeholder content items for at least the first 2-3 stages
   - Stage names from existing code: Beige, Purple, Red, Blue, Orange, Green, Yellow, Turquoise, Ultraviolet, Clear Light

4. **Register router in `main.py`**

5. **Write tests** — `tests/test_course_api.py`

### Frontend

6. **Rewrite `frontend/src/features/Course/CourseScreen.tsx`**
   - **Stage list view**: Vertical list of 10 stages, each showing title, progress bar, lock/unlock status
   - Stages unlock progressively (stage N+1 unlocks when stage N reaches a threshold)
   - Tap a stage to see its content

7. **Create `frontend/src/features/Course/StageDetail.tsx`**
   - Shows stage title, description, and list of content items
   - Each content item is tappable to read/complete
   - Progress indicator for the stage

8. **Create `frontend/src/features/Course/ContentViewer.tsx`**
   - Renders a content item (markdown text, exercise instructions, etc.)
   - "Mark Complete" button at the bottom
   - Back navigation to stage detail

9. **Update `api/index.ts`**
   - Add `course.stages()`, `course.stage(number)`, `course.content(stageNumber)`, `course.complete(stageNumber, contentId)`

10. **Update Course styles**

## Acceptance Criteria

- All 10 stages are displayed with correct names and colors
- Content items load for each stage
- Users can mark content as completed
- Stage progress reflects completed content items
- Locked stages are visually distinct and not accessible
- Backend tests cover all endpoints

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/course.py` | **Create** |
| `backend/src/schemas/course.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_course_api.py` | **Create** |
| `frontend/src/features/Course/CourseScreen.tsx` | Rewrite |
| `frontend/src/features/Course/StageDetail.tsx` | **Create** |
| `frontend/src/features/Course/ContentViewer.tsx` | **Create** |
| `frontend/src/features/Course/Course.styles.ts` | Modify |
| `frontend/src/api/index.ts` | Modify |
