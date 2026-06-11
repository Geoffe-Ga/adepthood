# phase-8-04: Page envelope — migrate the three deferred endpoint groups

**Labels:** `phase-8`, `frontend`, `pagination`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None (unblocks phase-8-05)
**Estimated LoC:** ~150

## Problem

Issue #408 (PR #448) migrated stages, habits, course content, and practices
to the `Page` envelope via `fetchAllPages`, but explicitly deferred three
groups "as their screens gain pagination": **goal groups**,
**user-practices**, and **practice-session history**. Their bare `list()`
call sites remain:

- `OnboardingModal.tsx:791` — `goalGroupsApi.list()` (template fetch).
- `useActivePractice.ts:97` — `userPractices.list()`.
- Practice-session history callers of `practiceSessions.list(...)`.

The backend default-flip (#221's end state, phase-8-05) is gated on these
being gone.

## Scope

Same fetch-all pattern as #448: add `listAll` wrappers draining the
existing `listPaginated` helpers, swap the call sites, update test mocks.
No load-more UI — all three lists are far below one page.

## Tasks

1. **API wrappers** (in `frontend/src/api/`)
   - `goalGroups.listAll(token?)` → drains `goalGroups.listPaginated`.
   - `userPractices.listAll(token?)` → drains `userPractices.listPaginated`.
   - `practiceSessions.listAll({ userPracticeId }, token?)` → drains
     `practiceSessions.listPaginated`.

2. **Swap call sites**
   - `OnboardingModal` template fetch; `useActivePractice`'s
     `userPractices.list()`; every `practiceSessions.list(` consumer
     (grep, excluding tests).

3. **Tests**
   - Extend `pagination-api.test.ts` with drain tests per new wrapper
     (mirroring #448's `stages.listAll` cases).
   - Update affected suite mocks (`OnboardingModal`, `useActivePractice`,
     practice-history tests) from `list:` to `listAll:` keys.

## Acceptance Criteria

- `grep -rn '\.list()' frontend/src --include='*.ts*' | grep -v __tests__`
  shows no `goalGroups`/`userPractices`/`practiceSessions` bare-list call
  site outside `api/`.
- New wrapper tests cover multi-page aggregation.
- Full frontend suite, tsc, eslint green.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` (or split modules) | Modify |
| `frontend/src/api/__tests__/pagination-api.test.ts` | Modify |
| `frontend/src/features/Habits/components/OnboardingModal.tsx` | Modify |
| `frontend/src/features/Practice/hooks/useActivePractice.ts` | Modify |
| Practice-session history consumers + tests | Modify |
