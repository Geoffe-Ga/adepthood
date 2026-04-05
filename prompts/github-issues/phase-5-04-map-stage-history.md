# phase-5-04: Add past practices and goals to Map stage detail modal

**Labels:** `phase-5`, `full-stack`, `feature`, `priority-medium`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~200

## Problem

The original Map prompt specifies:

> "Shows: Progress, Past practices & goals, Stage summaries including metadata"

The current Map stage detail modal shows metadata and a progress percentage, but no historical data. It has quick-action buttons to navigate to Practice/Course/Journal, but it doesn't answer the question: "What did I actually do in this stage?"

The prompt's vision is better because the Map is the natural place for retrospective reflection. It's meant to be the "skill tree" view — and skill trees show what you've accomplished, not just what percentage you've completed. Showing past practices and achieved goals per stage makes the Map a record of the user's journey.

## Scope

Add a "History" section to the Map stage detail modal that lists the user's past practice sessions and goal achievements for the selected stage. Requires a new backend endpoint to aggregate this data.

## Tasks

### 1. Create backend endpoint for stage history

Add to `backend/src/routers/stages.py`:

`GET /stages/{stage_number}/history` — Returns:
```json
{
  "stage_number": 3,
  "practices": [
    {
      "name": "Breath of Fire",
      "sessions_completed": 12,
      "total_minutes": 180,
      "last_session": "2026-03-15T10:30:00Z"
    }
  ],
  "habits": [
    {
      "name": "Morning Exercise",
      "icon": "🏃",
      "goals_achieved": {
        "low": true,
        "clear": true,
        "stretch": false
      },
      "best_streak": 14,
      "total_completions": 45
    }
  ]
}
```

Implementation:
- Query `UserPractice` + `PracticeSession` for the stage
- Query `Habit` + `GoalCompletion` for habits matching the stage
- Aggregate: count sessions, sum minutes, find best streak, determine which goal tiers were achieved

### 2. Create response schema

Add to `backend/src/schemas/stage.py`:
- `PracticeHistoryItem`: name, sessions_completed, total_minutes, last_session
- `HabitHistoryItem`: name, icon, goals_achieved (dict), best_streak, total_completions
- `StageHistoryResponse`: stage_number, practices (list), habits (list)

### 3. Add History section to MapScreen modal

In the stage detail modal (MapScreen.tsx, around line 203), below the existing metadata section, add:

**"Your Journey" section:**
- Collapsible/expandable section header
- **Practices subsection:** List each practice with session count and total minutes (e.g., "Breath of Fire — 12 sessions, 3 hrs")
- **Habits subsection:** List each habit with icon, name, best streak, and goal tier badges (bronze/silver/gold circles for low/clear/stretch achieved)
- **Empty state:** If stage hasn't been started, show "Begin this stage to start tracking your journey"
- If stage is locked, don't show the history section at all

### 4. Frontend API integration

Add to `frontend/src/api/index.ts`:
- `stages.history(stageNumber)` — calls `GET /stages/{stage_number}/history`

Fetch the history data when the modal opens (lazy load, not on Map mount).

### 5. Write tests

**Backend:**
- Test `/stages/{stage_number}/history` returns correct aggregation
- Test empty history for a stage with no activity
- Test that history only includes data for the requesting user

**Frontend:**
- Test that history section renders practice and habit items
- Test empty state message for unstarted stages
- Test that history section is hidden for locked stages

## Acceptance Criteria

- Map stage detail modal includes a "Your Journey" section
- Past practices show session count and total time
- Past habits show icon, name, best streak, and goal tier achievements
- Data is loaded lazily when the modal opens (not on Map mount)
- Empty state is shown for stages with no activity
- Locked stages do not show a history section
- Backend endpoint is auth-gated and returns only the requesting user's data

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/stages.py` | Modify (add history endpoint) |
| `backend/src/schemas/stage.py` | Modify (add history schemas) |
| `backend/tests/test_stages_history.py` | **Create** |
| `frontend/src/api/index.ts` | Modify (add stages.history) |
| `frontend/src/features/Map/MapScreen.tsx` | Modify (add history section) |
| `frontend/src/features/Map/__tests__/MapHistory.test.tsx` | **Create** |
