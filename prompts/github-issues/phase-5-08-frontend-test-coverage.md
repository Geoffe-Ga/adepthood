# phase-5-08: Add frontend test coverage for core screens and components

**Labels:** `phase-5`, `frontend`, `testing`, `priority-high`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~300

## Problem

The frontend has zero test files. The `find frontend/src -name "*.test.*"`
command returns nothing. CI passes only because Jest is configured with
`--passWithNoTests`. This means any refactoring, dependency update, or feature
addition has no safety net. The three most complex screens — HabitsScreen
(430 lines), JournalScreen (658 lines), and MapScreen (320 lines) — have no
test coverage at all.

## Scope

Add rendering and interaction tests for the three primary screens and the API
client module. Does NOT include E2E tests or visual regression tests.

## Tasks

1. **API client tests** (`frontend/src/api/__tests__/index.test.ts`)
   - Mock `fetch` globally
   - Test `request()` helper: GET, POST, error handling, 401 callback
   - Test `toLocalHabit()` conversion
   - Test token getter injection

2. **HabitsScreen tests** (`frontend/src/features/Habits/__tests__/HabitsScreen.test.tsx`)
   - Renders loading spinner initially
   - Renders habit list after data loads
   - Overflow menu opens on toggle press
   - Mode switching (stats, edit, quickLog)
   - Error banner renders on API failure with retry button

3. **JournalScreen tests** (`frontend/src/features/Journal/__tests__/JournalScreen.test.tsx`)
   - Renders loading indicator then message list
   - Sending a message shows optimistic update
   - Search bar filters messages
   - Tag filter toggles correctly
   - Balance banner shows when balance is 0

4. **MapScreen tests** (`frontend/src/features/Map/__tests__/MapScreen.test.tsx`)
   - Renders loading state then stage hotspots
   - Tapping a hotspot opens the stage detail modal
   - Navigation links (Practice, Course, Journal) call navigate
   - Progress bar width matches stage progress

## Acceptance Criteria

- At least 12 test cases across the 4 test files
- `npx jest` passes (no `--passWithNoTests` needed)
- Tests mock API calls and navigation — no network requests
- All tests use `@testing-library/react-native`
- No existing code changes required (tests only)

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/__tests__/index.test.ts` | **Create** |
| `frontend/src/features/Habits/__tests__/HabitsScreen.test.tsx` | **Create** |
| `frontend/src/features/Journal/__tests__/JournalScreen.test.tsx` | **Create** |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | **Create** |
