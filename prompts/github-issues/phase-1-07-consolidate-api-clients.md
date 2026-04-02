# phase-1-07: Consolidate frontend API clients into a single module

**Labels:** `phase-1`, `frontend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Estimated LoC:** ~200–250

## Problem

The frontend has **two competing API client implementations** with different patterns, different auth handling, and different type definitions:

**Client 1: `frontend/src/api/index.ts`**
- Generic `request<T>()` wrapper using `API_BASE_URL` from config
- Auth via optional `token` parameter per call
- Defines its own `Habit`, `JournalEntry`, `Stage`, `PracticeSession`, `AuthRequest`, `AuthResponse` interfaces
- Used nowhere (imported and voided in every screen)

**Client 2: `frontend/src/api/client.ts`**
- Standalone exported functions (`signup`, `login`, `createEnergyPlan`)
- Auth via module-level `let authToken` variable
- Uses OpenAPI-generated types from `types.ts`
- Also used nowhere

Additionally, `frontend/src/services/energyApi.ts` wraps `client.ts` but is never called, and `frontend/src/services/habitsApi.ts` is an empty file.

This creates confusion about which client to use, how auth should work, and what the canonical types are.

## Scope

Choose one pattern, delete the other, and establish a single source of truth for API communication.

## Tasks

1. **Keep `api/index.ts` as the canonical client** (it's simpler and more flexible)
   - It already has the right structure: resource-based exports (`habits.list()`, `journal.create()`, etc.)
   - Enhance its `request()` function to automatically include the auth token from a shared store (not passed per-call)

2. **Delete `api/client.ts`**
   - Move the `EnergyPlanRequest`/`EnergyPlanResponse` types to `api/index.ts` or `api/types.ts`
   - Remove the module-level `authToken` variable — auth tokens should live in a context or secure storage, not a module global

3. **Keep `api/types.ts`** (OpenAPI-generated types) as the canonical type source
   - Update `api/index.ts` interfaces to import from `types.ts` instead of defining their own
   - If `types.ts` is incomplete, extend it — don't create parallel definitions

4. **Delete dead service files**
   - Delete `services/habitsApi.ts` (empty)
   - Delete `services/energyApi.ts` (never called, wraps deleted client)

5. **Add proper error handling to `request()`**
   - Parse error response body for server error messages
   - Throw typed errors (not just `new Error("Request failed with status 404")`)
   - Consider a `class ApiError extends Error { status: number; detail: string }`

6. **Remove all `void` import hacks**
   - Delete `void habits;` from `HabitsScreen.tsx:26`
   - Delete `void journal;` from `JournalScreen.tsx:12`
   - Delete `void practice;` from `PracticeScreen.tsx:12`
   - Delete `void stages;` from `MapScreen.tsx:26`
   - These will be replaced with actual API calls in phase-1-08 and phase-3

7. **Add/update API client tests**
   - `__tests__/api.test.ts` needs to be updated for the consolidated client

## Acceptance Criteria

- One API client module (`api/index.ts`) with consistent auth handling
- `api/client.ts` deleted
- `services/habitsApi.ts` and `services/energyApi.ts` deleted
- No `void someApi;` lines remain
- Types imported from `api/types.ts` where possible
- Existing API tests updated and passing

## Files to Create/Modify/Delete

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | Modify (enhance request, consolidate types) |
| `frontend/src/api/client.ts` | **Delete** |
| `frontend/src/api/types.ts` | Modify (ensure complete) |
| `frontend/src/services/habitsApi.ts` | **Delete** |
| `frontend/src/services/energyApi.ts` | **Delete** |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (remove void import) |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify (remove void import) |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify (remove void import) |
| `frontend/src/features/Map/MapScreen.tsx` | Modify (remove void import) |
| `frontend/__tests__/api.test.ts` | Modify |
