# EPIC: Phase 3 — Build Missing Features

**Labels:** `epic`, `phase-3`, `priority-medium`

## Summary

Three of the five main app screens are placeholder text. The Journal, Practice, and Course screens each render a single `<Text>` component. The Map screen displays static data with hardcoded progress. The backend has models defined for all features but limited routers or business logic.

**This phase was expanded after cross-referencing the project specification documents** (`AdepthoodAppPrompt-2025-04-01.md`, `AdepthoodAppPrompt-2025-04-06.md`, and the habit prompts). The original 5 issues missed significant spec requirements including:

- Journal is a **chat interface with BotMason (AI)**, not just text entries
- Journal has **search, tagging, weekly reflection prompts**, and `offering_balance` metering
- Practice requires **UserPractice selection**, **sound cues**, and **post-practice journal linking**
- Course content is **drip-fed via `release_day`**, hosted on **Squarespace CMS**, with **Reflection → Journal deep links**
- Map needs **rich stage metadata** from the `CourseStage` model (spiral dynamics color, growing up stage, etc.)
- `GoalGroup`, `PromptResponse`, and `UserPractice` models exist but were completely unaddressed

## Current State

| Screen | Frontend | Backend |
|--------|----------|---------|
| Journal | `<Text>Journal Screen</Text>` (32 lines) | No router. `JournalEntry` model has `sender`, `is_stage_reflection`, `is_practice_note`, `is_habit_note`, `practice_session_id`. |
| Practice | `<Text>Practice Screen</Text>` (33 lines) | `practice_sessions` router (basic CRUD). `Practice`, `UserPractice`, `PracticeSession` models exist. |
| Course | `<Text>Course Screen</Text>` (29 lines) | No router. `CourseStage` has rich metadata (spiral_dynamics_color, divine_gender_polarity, etc.). `StageContent` has `release_day`, `content_type`, `url`. |
| Map | Static hotspots, hardcoded progress | No router. `StageProgress` model exists. |

## Sub-Issues (14)

### Backend Infrastructure
1. `phase-3-01` — Add backend routers for stages and stage progress
2. `phase-3-02` — Build Course backend: stage content with drip-feed scheduling
3. `phase-3-03` — Build Journal backend: chat messages, tagging, and search
4. `phase-3-04` — Build Practice backend: UserPractice selection and session linking
5. `phase-3-05` — Build PromptResponse backend: weekly reflection prompts

### Frontend — Journal (Chat with BotMason)
6. `phase-3-06` — Build Journal chat interface and message history
7. `phase-3-07` — Integrate BotMason AI with offering_balance metering
8. `phase-3-08` — Add journal search and entry tagging

### Frontend — Practice
9. `phase-3-09` — Build Practice screen: selection, timer with sound cues
10. `phase-3-10` — Add post-practice reflection → Journal linking

### Frontend — Course
11. `phase-3-11` — Build Course screen: stage content with drip-feed and CMS URLs
12. `phase-3-12` — Add Course → Journal "Reflection" deep links

### Frontend — Map
13. `phase-3-13` — Connect Map to real progress with rich stage metadata
14. `phase-3-14` — Add GoalGroup support to backend and frontend
