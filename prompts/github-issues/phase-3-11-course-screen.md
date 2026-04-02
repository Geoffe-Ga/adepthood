# phase-3-11: Build Course screen — stage content with drip-feed and CMS URLs

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-02, phase-3-01, phase-1-10
**Estimated LoC:** ~300

## Problem

The Course screen is a placeholder. The spec requires:

> "Displays essays, summaries, prompts, and Practice/Habit instructions for current stage"
> "Content pulled from StageContent model, hosted on the Squarespace CMS"
> "Features: 'Mark as Read', Journal links, Stage metadata, Drip-feed option"

The `StageContent` model has `content_type` (essay/prompt/video), `release_day` (drip-feed gating), and `url` (CMS link). Content is **not rendered in-app** — it's viewed via the CMS URL. The app provides the navigation, progress tracking, and gating.

The spec also requires:
> "Allow users to navigate between stages (locked until unlocked by progress) or revisit past stages"
> "Display a progress bar at the top of the screen indicating how much content the user has completed"
> "Use clean typography for readability and include small, symbolic graphics representing the stage's themes"

## Scope

Build the Course screen with stage navigation, drip-fed content listing, and read-tracking.

## Tasks

1. **Rewrite `frontend/src/features/Course/CourseScreen.tsx`**
   - **Stage selector** at top: horizontal scrollable list of 10 stages with their spiral dynamics color
   - Current stage highlighted, completed stages checkmarked, locked stages greyed with lock icon
   - Users can revisit completed stages but not access locked ones
   - **Progress bar** below stage selector showing content completion for selected stage
   - **Content list** below: FlatList of content items for the selected stage

2. **Create `frontend/src/features/Course/StageSelector.tsx`**
   - Horizontal list of stage circles/pills with stage number and color
   - Active stage emphasized, locked stages dimmed
   - Tapping a stage loads its content

3. **Create `frontend/src/features/Course/ContentCard.tsx`**
   - Shows: title, content_type icon (book for essay, chat for prompt, play for video), release status
   - If locked (`release_day > days_since_start`): shows "Unlocks in X days", greyed out, not tappable
   - If unlocked and unread: normal styling, tappable
   - If read: checkmark, slightly dimmed
   - Tapping an unlocked item opens the CMS URL via `Linking.openURL(url)` or an in-app WebView

4. **Create `frontend/src/features/Course/ContentViewer.tsx`**
   - WebView or external link to the CMS-hosted content
   - "Mark as Read" button at the bottom (calls `POST /course/content/{id}/mark-read`)
   - Back navigation to content list

5. **Add course stage metadata display**
   - When a stage is selected, show its rich metadata from `CourseStage`:
     - Title and subtitle
     - Spiral Dynamics color and growing up stage name
     - Brief description / overview
   - This data comes from the stages API (phase-3-01)

6. **Update `api/index.ts`**
   - `course.stageContent(stageNumber)` — list content for a stage
   - `course.markRead(contentId)` — mark content as read
   - `course.stageProgress(stageNumber)` — get read/total progress

7. **Ensure compatibility with light/dark modes** (spec requirement)
   - Use theme colors from design tokens (phase-2-05)
   - Content cards should look good in both modes

## Acceptance Criteria

- All 10 stages navigable with proper lock/unlock status
- Content items displayed with drip-feed gating (locked items show unlock date)
- Tapping unlocked content opens the CMS URL
- "Mark as Read" tracks progress
- Progress bar reflects read/total ratio per stage
- Stage metadata displayed from CourseStage model

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/CourseScreen.tsx` | Rewrite |
| `frontend/src/features/Course/StageSelector.tsx` | **Create** |
| `frontend/src/features/Course/ContentCard.tsx` | **Create** |
| `frontend/src/features/Course/ContentViewer.tsx` | **Create** |
| `frontend/src/features/Course/Course.styles.ts` | Rewrite |
| `frontend/src/api/index.ts` | Modify |
