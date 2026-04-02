# phase-4-06: Add integration and E2E test coverage

**Labels:** `phase-4`, `testing`, `priority-low`
**Epic:** Phase 4 — Polish & Harden
**Estimated LoC:** ~300

## Problem

Current tests are narrow:
- **Backend**: Unit tests for individual endpoints and domain functions. No tests that exercise a multi-step flow (e.g., signup → create habit → log completion → check progress).
- **Frontend**: Snapshot tests for OnboardingModal, unit tests for HabitUtils, basic API client tests. No tests that simulate a user flow (e.g., add a habit → log units → see progress bar update → check stats).
- **No E2E tests**: Nothing tests the full stack (frontend → API → database → response → UI update).

**Specific gaps from the review:**
- No tests for HabitSettingsModal functionality
- No tests for StatsModal rendering with real data
- No tests for ReorderHabitsModal drag behavior
- No tests for MissedDaysModal backfill logic
- No tests for notification scheduling/cancellation
- No tests for offline → online sync
- No tests for auth token expiry → logout flow

## Scope

Add integration tests that cover multi-step user flows, and optionally set up E2E testing infrastructure.

## Tasks

### Backend Integration Tests

1. **Create `tests/test_integration.py`**
   - Test: Signup → Create habit → Log completion → Check goal progress → Verify milestone triggered
   - Test: Create multiple habits → Reorder → Verify sort order persisted
   - Test: Create practice session → Check week count → Verify count is correct
   - Test: Expired token → All endpoints return 401

2. **Create `tests/test_energy_integration.py`**
   - Test: Create habits → Generate energy plan → Verify plan uses correct habits
   - Test: Idempotent request → Same response returned
   - Test: Empty habits → 400 error (not 500)

### Frontend Integration Tests

3. **Create component integration tests using Testing Library**
   - Test: Render HabitsScreen → Tap habit → GoalModal opens → Log unit → Progress bar updates
   - Test: Render HabitsScreen → Enter Quick Log mode → Tap habit → Unit logged without modal
   - Test: Render OnboardingModal → Complete all steps → Habits created with correct defaults
   - Mock the API layer with MSW (Mock Service Worker) or jest mocks

4. **Create store integration tests** (if Zustand from phase-2-03)
   - Test: `useHabitStore.fetchHabits()` → store.habits populated
   - Test: `useHabitStore.logCompletion()` → optimistic update → API called → state consistent

### Optional: E2E Tests

5. **Set up Detox or Maestro for E2E testing**
   - Configure for iOS simulator and Android emulator
   - Write 2-3 critical path tests:
     - Login → See habits → Log a unit → Verify persistence
     - Navigate all 5 tabs → Verify each loads
     - Create a journal entry → Verify it appears in the list

6. **Add E2E test job to CI** (`.github/workflows/e2e-ci.yml`)

## Acceptance Criteria

- Backend has at least 3 multi-step integration tests
- Frontend has at least 3 component integration tests
- All integration tests pass in CI
- Optional: E2E test infrastructure set up with at least 1 passing test

## Files to Create

| File | Action |
|------|--------|
| `backend/tests/test_integration.py` | **Create** |
| `backend/tests/test_energy_integration.py` | **Create** |
| `frontend/src/features/Habits/__tests__/HabitsIntegration.test.tsx` | **Create** |
| `frontend/src/features/Habits/__tests__/OnboardingFlow.test.tsx` | **Create** |
| `frontend/src/store/__tests__/useHabitStore.test.ts` | **Create** |
