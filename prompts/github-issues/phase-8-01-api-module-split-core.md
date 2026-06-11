# phase-8-01: Split api/index.ts — extract core domain modules (habits, goals, journal, auth)

**Labels:** `phase-8`, `frontend`, `architecture`, `priority-high`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~350 (mostly moves; net new ≈ 40)

## Problem

`frontend/src/api/index.ts` is **2,639 lines** and still growing — every
feature PR this quarter touched it (#403 BYOK, #407/#408 pagination, #426
days_of_week). It holds the HTTP plumbing (`request`, token getters, retry,
Zod validation), every domain's TypeScript interfaces, and ten domain
clients in one file. Current state: `wc -l` 2,639; the file contains
`auth`, `users`, `habits`, `goalCompletions`, `goals`, `goalGroups`,
`journal`, `prompts`, `botmason`, `stages`, `course`, `practices`,
`userPractices`, `practiceSessions`, `practiceTags`, `practiceRecipes`,
`shareLinks` plus `fetchAllPages` and the `Page` machinery.

## Scope

First of two mechanical extractions. Move the shared plumbing and the four
highest-churn domains into per-domain modules under `frontend/src/api/`;
`index.ts` re-exports everything so **no import site changes**. The
remaining domains move in phase-8-02.

## Tasks

1. **Extract shared plumbing to `api/client.ts`**
   - Move `request`, `ApiError`, `ApiValidationError`, token-getter wiring,
     `setNetworkOnlineGetter` hooks, retry/validation internals.
   - Move `Page`, `PaginationParams`, `pageQuery`, `loosePageSchema`,
     `fetchAllPages` to `api/pagination.ts`.

2. **Extract domain modules**
   - `api/auth.ts` — `auth` client + its request/response interfaces.
   - `api/habits.ts` — `habits`, `goalCompletions`, `goals`, `goalGroups`
     clients + `ApiHabit*`, `ApiGoal*`, `GoalUpdatePayload` types.
   - `api/journal.ts` — `journal`, `prompts`, `botmason` clients + types
     (these three share the chat/prompt surface).

3. **Re-export from `index.ts`**
   - `export * from './client'` etc.; keep named exports identical so
     `import { habits } from '../../api'` continues to compile everywhere.
   - Run `npx tsc --noEmit` and the full jest suite to prove zero behavior
     change; no test file should need edits.

## Acceptance Criteria

- `api/index.ts` shrinks below ~1,200 lines; new modules each < 700.
- Zero changes outside `frontend/src/api/` (imports stay stable).
- `npm test`, `npx tsc --noEmit`, `npm run lint` green with no test edits.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/client.ts` | **Create** |
| `frontend/src/api/pagination.ts` | **Create** |
| `frontend/src/api/auth.ts` | **Create** |
| `frontend/src/api/habits.ts` | **Create** |
| `frontend/src/api/journal.ts` | **Create** |
| `frontend/src/api/index.ts` | Modify (remove moved code, re-export) |
