# phase-8-02: Split api/index.ts — extract remaining domains, reduce index to a barrel

**Labels:** `phase-8`, `frontend`, `architecture`, `priority-high`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** phase-8-01
**Estimated LoC:** ~350 (mostly moves; net new ≈ 30)

## Problem

After phase-8-01, `frontend/src/api/index.ts` still carries the course,
practice, stage, and user domains plus their Zod schemas — several hundred
lines each. The goal state is an `index.ts` that is purely a barrel.

## Scope

Move the remaining domains into per-domain modules; `index.ts` becomes
re-exports only. Same zero-import-churn constraint as phase-8-01.

## Tasks

1. **Extract domain modules**
   - `api/course.ts` — `stages`, `course` clients + `Stage`, `ContentItem`,
     `ContentBody`, `SiteResource`, `CourseProgress` types.
   - `api/practices.ts` — `practices`, `userPractices`, `practiceSessions`,
     `practiceTags`, `practiceRecipes`, `shareLinks` clients + types
     (`PracticeItem`, `UserPractice`, `PracticeSessionResponse`, …).
   - `api/users.ts` — `users` client + timezone/profile types.

2. **Reduce `index.ts` to a barrel**
   - Only `export *` / explicit re-export lines remain (< 60 lines).
   - Grep-verify: `grep -c 'function\|=>' frontend/src/api/index.ts`
     returns 0 implementation code.

3. **Prove zero behavior change**
   - Full jest suite, `tsc --noEmit`, eslint — all green with no edits
     outside `frontend/src/api/`.

## Acceptance Criteria

- `api/index.ts` < 60 lines, re-exports only.
- Every new module < 700 lines.
- Zero changes outside `frontend/src/api/`; no test file edited.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/course.ts` | **Create** |
| `frontend/src/api/practices.ts` | **Create** |
| `frontend/src/api/users.ts` | **Create** |
| `frontend/src/api/index.ts` | Modify (barrel only) |
