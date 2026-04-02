# EPIC: Phase 3 — Build Missing Features

**Labels:** `epic`, `phase-3`, `priority-medium`

## Summary

Three of the five main app screens are placeholder text. The Journal, Practice, and Course screens each render a single `<Text>` component with the screen name. The Map screen displays static data with hardcoded progress values. The backend has models defined for all of these features but no routers or business logic to support them.

This phase implements the remaining features to make the app functionally complete across all five tabs.

## Current State

| Screen | Frontend | Backend |
|--------|----------|---------|
| Journal | `<Text>Journal Screen</Text>` (32 lines) | No router. `JournalEntry` model exists. |
| Practice | `<Text>Practice Screen</Text>` (33 lines) | `practice_sessions` router exists (CRUD + week_count) |
| Course | `<Text>Course Screen</Text>` (29 lines) | No router. `CourseStage`, `StageContent` models exist. |
| Map | Static hotspots, hardcoded progress | No router. `StageProgress` model exists. |

## Success Criteria

- All five screens are functional with real data
- Journal entries can be created, listed, and viewed
- Practice sessions can be started, timed, and logged
- Course content can be browsed by stage
- Map shows real progress derived from habit/practice/course completion

## Sub-Issues

1. `phase-3-01` — Build Journal backend router and frontend screen
2. `phase-3-02` — Build Practice frontend screen with timer and session logging
3. `phase-3-03` — Build Course backend router and frontend screen
4. `phase-3-04` — Connect Map screen to real progress data
5. `phase-3-05` — Add backend routers for stages and stage progress
